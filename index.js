const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

const app = express();

// ===== 環境變數 =====
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const ALLOWED_GROUP_IDS = process.env.ALLOWED_GROUP_IDS
  ? process.env.ALLOWED_GROUP_IDS.split(',').map(id => id.trim())
  : [];

// ===== 資料儲存 =====
const sessions = {};
const deptSettings = {};
const pendingDeptSettings = {};
const nicknameSettings = {};
const pendingNicknameSettings = {};

// ===== 台灣時間 =====
function getTaiwanTime() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}

function formatTime(date) {
  if (!date) return '';
  const tw = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const h = String(tw.getHours()).padStart(2, '0');
  const m = String(tw.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// ===== LINE API =====
async function replyMessage(replyToken, messages) {
  await axios.post('https://api.line.me/v2/bot/message/reply', {
    replyToken,
    messages: Array.isArray(messages) ? messages : [messages]
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
    }
  });
}

async function pushMessage(to, messages) {
  await axios.post('https://api.line.me/v2/bot/message/push', {
    to,
    messages: Array.isArray(messages) ? messages : [messages]
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`
    }
  });
}

async function getMemberName(groupId, userId) {
  // 優先使用暱稱
  if (nicknameSettings[groupId] && nicknameSettings[groupId][userId]) {
    return nicknameSettings[groupId][userId];
  }
  try {
    const url = groupId
      ? `https://api.line.me/v2/bot/group/${groupId}/member/${userId}`
      : `https://api.line.me/v2/profile/${userId}`;
    const res = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
    });
    return res.data.displayName;
  } catch {
    return '某位同事';
  }
}

function getNicknameSettings(groupId) {
  if (!nicknameSettings[groupId]) nicknameSettings[groupId] = {};
  return nicknameSettings[groupId];
}

function getPendingNicknameSettings(groupId) {
  if (!pendingNicknameSettings[groupId]) pendingNicknameSettings[groupId] = {};
  return pendingNicknameSettings[groupId];
}

// ===== 工具函式 =====
function getSession(groupId) {
  if (!sessions[groupId]) {
    sessions[groupId] = {
      isOpen: false,
      openTime: null,
      deadline: null,
      deadlineTimer: null,
      orders: {}
    };
  }
  return sessions[groupId];
}

function getDeptSettings(groupId) {
  if (!deptSettings[groupId]) deptSettings[groupId] = {};
  return deptSettings[groupId];
}

function getPendingDeptSettings(groupId) {
  if (!pendingDeptSettings[groupId]) pendingDeptSettings[groupId] = {};
  return pendingDeptSettings[groupId];
}

// ===== 解析點餐訊息 =====
function parseOrderText(text) {
  let itemName = text.trim();
  let price = null;
  let note = null;
  let qty = 1;

  // 抓括號備註
  const bracketMatch = itemName.match(/[（(]([^）)]+)[）)]/);
  if (bracketMatch) {
    note = bracketMatch[1].trim();
    itemName = itemName.replace(bracketMatch[0], '').trim();
  }

  // 抓「備註」關鍵字
  const noteKeywordMatch = itemName.match(/^(.+?)\s+備註\s+(.+)$/);
  if (noteKeywordMatch) {
    itemName = noteKeywordMatch[1].trim();
    note = noteKeywordMatch[2].trim();
  }

  // 抓「價格*數量」格式
  // 必須是「空格或$」+數字+[*×xX]+數字 結尾
  // 例：雞腿便當 80*2、雞腿便當$80*2、排骨飯 60 *1
  const priceQtyMatch = itemName.match(/^(.+?)[\s$](\d+)\s*[*×xX]\s*(\d+)$/) ||
                        itemName.match(/^(.+?)\s*\$(\d+)\s*[*×xX]\s*(\d+)$/);
  if (priceQtyMatch) {
    itemName = priceQtyMatch[1].trim();
    price = parseInt(priceQtyMatch[2]);
    qty = parseInt(priceQtyMatch[3]);
    return { itemName, price, note, qty };
  }

  // 抓價格（支援空格或$符號後接數字）
  // 麵線$50、麵線 50、麵線 $50
  const priceMatch = itemName.match(/^(.+?)\s*\$(\d+)$/) ||
                     itemName.match(/^(.+?)\s+(\d+)$/);
  if (priceMatch) {
    itemName = priceMatch[1].trim();
    price = parseInt(priceMatch[2]);
  }

  return { itemName, price, note, qty };
}

// ===== 建立結單訊息（2則）=====
function buildSummaryMessages(session, groupId) {
  const orders = session.orders;
  const userIds = Object.keys(orders).filter(uid => orders[uid].items.length > 0);
  const depts = getDeptSettings(groupId);

  if (userIds.length === 0) {
    return [{ type: 'text', text: '本輪沒有任何訂單。' }];
  }

  // ===== 第1則：依科室，依餐點整理 =====
  // 分組
  const deptMap = {};
  const noDept = [];

  for (const uid of userIds) {
    const o = orders[uid];
    // 優先從deptSettings取科室，確保設定代號後科室仍正確
    const dept = depts[uid] || o.dept || null;
    if (dept) {
      if (!deptMap[dept]) deptMap[dept] = [];
      deptMap[dept].push({ uid, name: o.name, items: o.items });
    } else {
      noDept.push({ uid, name: o.name, items: o.items });
    }
  }

  // 計算科室內依餐點彙整
  function buildDeptSection(members) {
    // 把同科室的餐點整理：key 包含名稱、備註、價格，三者都相同才合併
    const itemMap = {};
    for (const m of members) {
      for (const item of m.items) {
        const priceKey = item.price !== null ? item.price : 'null';
        const noteKey = item.note || '';
        const key = `${item.name}||${noteKey}||${priceKey}`;
        if (!itemMap[key]) itemMap[key] = { name: item.name, note: item.note || null, price: item.price, qty: 0, names: [] };
        itemMap[key].qty += item.qty;
        if (!itemMap[key].names.includes(m.name)) {
          itemMap[key].names.push(m.name);
        }
      }
    }
    return itemMap;
  }

  function calcDeptTotal(itemMap) {
    return Object.values(itemMap).reduce((sum, v) =>
      sum + (v.price !== null ? v.price * v.qty : 0), 0);
  }

  let msg1 = '已結單！\n';
  let grandTotal = 0;
  let grandQty = 0;

  // 有科室的部分
  for (const [dept, members] of Object.entries(deptMap)) {
    const itemMap = buildDeptSection(members);
    const deptTotal = calcDeptTotal(itemMap);
    grandTotal += deptTotal;
    msg1 += `\n${dept}　小計 $${deptTotal}\n`;
    for (const [key, data] of Object.entries(itemMap)) {
      const priceStr = data.price !== null ? `${data.price}` : '';
      const noteStr = data.note ? `（${data.note}）` : '';
      const names = data.names.join('、');
      msg1 += `  ${data.name}${noteStr}${priceStr}×${data.qty}（${names}）\n`;
      grandQty += data.qty;
    }
  }

  // 未設定科室
  if (noDept.length > 0) {
    const itemMap = buildDeptSection(noDept);
    const deptTotal = calcDeptTotal(itemMap);
    grandTotal += deptTotal;
    msg1 += `\n未設定科室　小計 $${deptTotal}\n`;
    for (const [key, data] of Object.entries(itemMap)) {
      const priceStr = data.price !== null ? `${data.price}` : '';
      const noteStr = data.note ? `（${data.note}）` : '';
      const names = data.names.join('、');
      msg1 += `  ${data.name}${noteStr}${priceStr}×${data.qty}（${names}）\n`;
      grandQty += data.qty;
    }
  }

  msg1 += `\n共 ${grandQty} 份\n總金額：$${grandTotal} 元`;

  // ===== 第2則：依餐點統計（含備註、價格不同分開統計）=====
  const allItemMap = {};
  let totalQty = 0;
  let totalAmount = 0;

  for (const uid of userIds) {
    for (const item of orders[uid].items) {
      // key 包含名稱、備註、價格，三者都相同才合併
      const priceKey = item.price !== null ? item.price : 'null';
      const noteKey = item.note || '';
      const key = `${item.name}||${noteKey}||${priceKey}`;
      if (!allItemMap[key]) {
        allItemMap[key] = { name: item.name, note: item.note || null, price: item.price, qty: 0 };
      }
      allItemMap[key].qty += item.qty;
      totalQty += item.qty;
      totalAmount += item.price !== null ? item.price * item.qty : 0;
    }
  }

  let msg2 = '';
  for (const [key, data] of Object.entries(allItemMap)) {
    const priceStr = data.price !== null ? `${data.price}` : '';
    const noteStr = data.note ? `（${data.note}）` : '';
    msg2 += `${data.name}${noteStr}${priceStr}×${data.qty}\n`;
  }
  msg2 += `\n共 ${totalQty} 份\n總金額：$${totalAmount} 元`;

  return [
    { type: 'text', text: msg1 },
    { type: 'text', text: msg2 }
  ];
}

// ===== 便條紙樣式（依科室分裝）=====
function buildSlipMessages(session, groupId) {
  const orders = session.orders;
  const userIds = Object.keys(orders).filter(uid => orders[uid].items.length > 0);
  const depts = {};
  // 取得科室設定
  if (deptSettings[groupId]) {
    Object.assign(depts, deptSettings[groupId]);
  }

  if (userIds.length === 0) {
    return [{ type: 'text', text: '目前還沒有任何訂單！' }];
  }

  const deptMap = {};
  const noDept = [];

  for (const uid of userIds) {
    const o = orders[uid];
    const dept = depts[uid] || o.dept || null;
    if (dept) {
      if (!deptMap[dept]) deptMap[dept] = [];
      deptMap[dept].push({ name: o.name, items: o.items });
    } else {
      noDept.push({ name: o.name, items: o.items });
    }
  }

  function buildDeptItemMap(members) {
    const itemMap = {};
    for (const m of members) {
      for (const item of m.items) {
        const priceKey = item.price !== null ? item.price : 'null';
        const noteKey = item.note || '';
        const key = `${item.name}||${noteKey}||${priceKey}`;
        if (!itemMap[key]) itemMap[key] = { name: item.name, note: item.note || null, price: item.price, qty: 0 };
        itemMap[key].qty += item.qty;
      }
    }
    return itemMap;
  }

  let msg = '';
  let deptIndex = 1;

  for (const [dept, members] of Object.entries(deptMap)) {
    const itemMap = buildDeptItemMap(members);
    msg += `第${deptIndex}張單（${dept}）\n`;
    for (const [key, data] of Object.entries(itemMap)) {
      const priceStr = data.price !== null ? `${data.price}` : '';
      const noteStr = data.note ? `（${data.note}）` : '';
      msg += `${data.name}${noteStr}${priceStr}×${data.qty}\n`;
    }
    msg += '\n';
    deptIndex++;
  }

  if (noDept.length > 0) {
    const itemMap = buildDeptItemMap(noDept);
    msg += `第${deptIndex}張單（未設定科室）\n`;
    for (const [key, data] of Object.entries(itemMap)) {
      const priceStr = data.price !== null ? `${data.price}` : '';
      const noteStr = data.note ? `（${data.note}）` : '';
      msg += `${data.name}${noteStr}${priceStr}×${data.qty}\n`;
    }
  }

  return [{ type: 'text', text: msg.trim() }];
}

// ===== 自動結單 =====
async function autoClose(groupId) {
  const session = getSession(groupId);
  session.isOpen = false;
  session.deadlineTimer = null;
  const msgs = buildSummaryMessages(session, groupId);
  try {
    await pushMessage(groupId, msgs);
  } catch (e) {
    console.error('Auto close push error:', e.message);
  }
}

// ===== 解析結單時間 =====
function parseDeadlineTime(timeStr) {
  const match = timeStr.replace('結單', '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1]);
  const m = parseInt(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;

  // 取得現在的 UTC 時間，加上台灣時區偏移（+8小時）計算目標時間
  const now = new Date();
  // 台灣時間 = UTC + 8小時
  const taiwanOffsetMs = 8 * 60 * 60 * 1000;
  // 計算今天台灣時間的 deadline（UTC）
  const todayUtcMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));
  // 台灣時間的 deadline = 今天 UTC 00:00 - 8小時偏移 + 目標小時分鐘
  const deadlineUtc = new Date(todayUtcMidnight.getTime() - taiwanOffsetMs + (h * 60 + m) * 60 * 1000);
  return deadlineUtc;
}

// ===== 主要訊息處理 =====
async function handleMessage(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const text = event.message.text.trim();
  const replyToken = event.replyToken;
  const userId = event.source.userId;
  const groupId = event.source.groupId || event.source.roomId || userId;
  const isGroup = !!event.source.groupId || !!event.source.roomId;

  // 白名單檢查
  if (ALLOWED_GROUP_IDS.length > 0 && isGroup && !ALLOWED_GROUP_IDS.includes(groupId)) return;

  const session = getSession(groupId);
  const depts = getDeptSettings(groupId);
  const pendingDepts = getPendingDeptSettings(groupId);
  const nicknames = getNicknameSettings(groupId);
  const pendingNicknames = getPendingNicknameSettings(groupId);

  // ── 代號設定 ──
  const nicknameKeywords = ['我的代號', '我的暱稱', '設定代號', '設定暱稱'];
  const isNicknameCmd = nicknameKeywords.some(k => text.startsWith(k));

  if (isNicknameCmd) {
    // 移除關鍵字後取得剩餘內容
    let remaining = text;
    for (const k of nicknameKeywords) {
      if (remaining.startsWith(k)) {
        remaining = remaining.slice(k.length).trim();
        break;
      }
    }

    const parts = remaining.split(/\s+/);

    if (parts.length === 0 || remaining === '') {
      // 沒有輸入任何內容
      await replyMessage(replyToken, { type: 'text', text: '請輸入代號，例：\n我的代號 小明\n設定代號 陳大明 小明' });
      return;
    } else if (parts.length === 1) {
      // 只有一個參數 → 設定自己的代號
      const nickname = parts[0];
      nicknames[userId] = nickname;
      if (session.orders[userId]) session.orders[userId].name = nickname;
      await replyMessage(replyToken, { type: 'text', text: `已設定你的代號為「${nickname}」` });
      return;
    } else {
      // 兩個以上參數 → 幫別人設定代號
      // 最後一個是代號，前面全部是LINE名稱
      const nickname = parts[parts.length - 1];
      const lineName = parts.slice(0, parts.length - 1).join(' ');
      pendingNicknames[lineName] = nickname;
      await replyMessage(replyToken, { type: 'text', text: `已預設「${lineName}」的代號為「${nickname}」\n等 ${lineName} 點餐後自動綁定！` });
      return;
    }
  }

  // ── 口語格式：XX的代號是OO 或 XX的暱稱是OO ──
  const naturalNicknameMatch = text.match(/^(.+)的(代號|暱稱)是(\S+)$/);
  if (naturalNicknameMatch) {
    const lineName = naturalNicknameMatch[1].trim();
    const nickname = naturalNicknameMatch[3].trim();
    pendingNicknames[lineName] = nickname;
    await replyMessage(replyToken, { type: 'text', text: `已預設「${lineName}」的代號為「${nickname}」\n等 ${lineName} 點餐後自動綁定！` });
    return;
  }

  // ── 查看暱稱設定 ──
  if (text === '暱稱設定' || text === '查看暱稱' || text === '代號設定' || text === '查看代號') {
    const entries = Object.entries(nicknames);
    if (entries.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '目前沒有任何暱稱設定。\n請輸入「我的暱稱 你的暱稱」' });
      return;
    }
    let msg = '目前暱稱設定：\n';
    for (const [uid, nick] of entries) {
      msg += `  ${nick}\n`;
    }
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 設定科室（自己）──
  if (text.startsWith('設定科室') && !text.match(/設定科室\s+\S+\s+\S+/)) {
    const dept = text.replace('設定科室', '').trim();
    if (!dept) {
      await replyMessage(replyToken, { type: 'text', text: '請輸入科室名稱，例：設定科室 行政部' });
      return;
    }
    depts[userId] = dept;
    // 同步更新訂單裡的科室和名稱（確保使用代號而非原本LINE名稱）
    const name = await getMemberName(groupId, userId);
    if (session.orders[userId]) {
      session.orders[userId].dept = dept;
      session.orders[userId].name = name; // 同步更新名稱（可能是代號）
    }
    await replyMessage(replyToken, { type: 'text', text: `已設定 ${name} 的科室為「${dept}」` });
    return;
  }

  // ── 幫別人設定科室（名字是科室）──
  const deptByNameMatch1 = text.match(/^(\S+)是(\S+)$/);
  if (deptByNameMatch1) {
    const targetName = deptByNameMatch1[1].trim();
    const dept = deptByNameMatch1[2].trim();
    pendingDepts[targetName] = dept;
    await replyMessage(replyToken, { type: 'text', text: `已預設「${targetName}」的科室為「${dept}」\n等 ${targetName} 點餐後自動綁定！` });
    return;
  }

  // ── 幫別人設定科室（名字 科室，只在未開單時生效）──
  if (!session.isOpen) {
    const deptByNameMatch2 = text.match(/^(\S+)\s+(\S+)$/);
    if (deptByNameMatch2) {
      const targetName = deptByNameMatch2[1].trim();
      const dept = deptByNameMatch2[2].trim();
      // 排除指令關鍵字
      const keywords = ['開單', '結單', '說明', '開始訂餐', '開始點餐', '查看訂單', '目前訂單', '我的訂單', '取消全部', '科室設定', '查看科室', '設定代號', '設定暱稱', '我的代號', '我的暱稱', '查看代號', '查看暱稱', '代號設定', '暱稱設定'];
      if (!keywords.includes(targetName)) {
        pendingDepts[targetName] = dept;
        await replyMessage(replyToken, { type: 'text', text: `已預設「${targetName}」的科室為「${dept}」\n等 ${targetName} 點餐後自動綁定！` });
        return;
      }
    }
  }

  // ── 批次設定科室 ──
  if (text.startsWith('批次設定科室') && !text.startsWith('批次設定科室+代號') && !text.startsWith('批次設定科室＋代號')) {
    const lines = text.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '請輸入名單，例：\n批次設定科室\n陳小明/行政部\n王貞（小詠）/業務部' });
      return;
    }
    let msg = '✅ 已批次設定科室：\n';
    let count = 0;
    for (const line of lines) {
      const parts = line.split('/').map(p => p.trim());
      if (parts.length < 2) continue;
      const lineName = parts[0];
      const dept = parts[1];
      pendingDepts[lineName] = dept;
      msg += `  ${lineName} → ${dept}\n`;
      count++;
    }
    msg += `\n共 ${count} 人，等以上成員點餐後自動綁定！`;
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 批次設定代號 ──
  if (text.startsWith('批次設定代號')) {
    const lines = text.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '請輸入名單，例：\n批次設定代號\n陳小明/Tina\n王貞（小詠）/棠棠' });
      return;
    }
    let msg = '✅ 已批次設定代號：\n';
    let count = 0;
    for (const line of lines) {
      const parts = line.split('/').map(p => p.trim());
      if (parts.length < 2) continue;
      const lineName = parts[0];
      const nickname = parts[1];
      pendingNicknames[lineName] = nickname;
      msg += `  ${lineName} → ${nickname}\n`;
      count++;
    }
    msg += `\n共 ${count} 人，等以上成員點餐後自動綁定！`;
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 批次設定科室＋代號 ──
  if (text.startsWith('批次設定科室+代號') || text.startsWith('批次設定科室＋代號')) {
    const lines = text.split('\n').slice(1).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '請輸入名單，例：\n批次設定科室+代號\n陳小明/行政部/Tina\n王貞（小詠）/業務部/棠棠\n小宇/業務部（無代號）' });
      return;
    }
    let msg = '✅ 已批次設定：\n';
    let count = 0;
    for (const line of lines) {
      const parts = line.split('/').map(p => p.trim());
      if (parts.length < 2) continue;
      const lineName = parts[0];
      const dept = parts[1];
      const nickname = parts[2] || null;
      pendingDepts[lineName] = dept;
      if (nickname) {
        pendingNicknames[lineName] = nickname;
        msg += `  ${lineName} → ${dept}，代號：${nickname}\n`;
      } else {
        msg += `  ${lineName} → ${dept}（無代號）\n`;
      }
      count++;
    }
    msg += `\n共 ${count} 人，等以上成員點餐後自動綁定！`;
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 查看科室設定 ──
  if (text === '科室設定' || text === '查看科室') {
    const entries = Object.entries(depts);
    const pendingEntries = Object.entries(pendingDepts);
    if (entries.length === 0 && pendingEntries.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '目前沒有任何科室設定。\n請輸入「設定科室 你的部門」' });
      return;
    }
    let msg = '目前科室設定：\n';
    for (const [uid, dept] of entries) {
      const name = await getMemberName(groupId, uid);
      msg += `  ${name} → ${dept}\n`;
    }
    if (pendingEntries.length > 0) {
      msg += '\n待綁定（點餐後自動對應）：\n';
      for (const [name, dept] of pendingEntries) {
        msg += `  ${name} → ${dept}\n`;
      }
    }
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 說明 ──
  if (['說明', 'help', '？', '?'].includes(text.toLowerCase())) {
    const help = `訂餐機器人指令說明

開單
  開單 11:30
  開始點餐 11:30
  開始訂餐 11:30
  （不附時間則手動結單）

點餐（開單後直接輸入）
  雞腿便當 80
  雞腿便當80*2
  雞腿便當$80*2
  雞腿便當（少冰）80
  雞腿便當 備註 少冰 80
  （開單期間 # 開頭不記錄）

取消（自己）
  取消雞腿便當（取消1份）
  取消雞腿便當*2（取消2份）
  取消所有雞腿便當（取消全部份數）
  取消我的訂單（取消自己所有）

取消（他人）
  取消 @小明的雞腿便當
  取消 @小明的雞腿便當*2
  取消 @小明的所有訂單
  取消 @All的雞腿便當（取消所有人）
  取消 @All的所有訂單

修改
  雞腿便當改60元（改價格）
  雞腿便當改2份（改數量）
  全部加5 / 全部減5
  全部打9折

查看個人訂單
  我的訂單
  我的餐點

查看全部訂單
  所有訂單
  目前訂單
  查看訂單
  所有的訂單
  現在的訂單
  全部的訂單

結單
  結單
  11:30結單

科室設定
  設定科室 行政部（自己）
  阿明是行政部（幫別人設定）
  阿明 行政部（未開單時）
  查看科室

批次設定（用/分隔）
  批次設定科室
  陳小明/行政部
  王貞（小詠）/業務部

  批次設定代號
  陳小明/Tina
  王貞（小詠）/棠棠

  批次設定科室+代號
  陳小明/行政部/Tina
  王貞（小詠）/業務部/棠棠
  小宇/業務部（無代號）

代號設定
  我的代號 小明
  設定代號 小明
  設定代號 很長的LINE名稱 小明（幫別人設定）
  查看代號`;
    await replyMessage(replyToken, { type: 'text', text: help });
    return;
  }

  // ── 開單 ──
  const openKeywords = ['開始點餐', '開始訂餐', '開單'];
  const isOpenCmd = openKeywords.some(k => text.startsWith(k));
  if (isOpenCmd) {
    // 移除關鍵字，取得剩餘部分（時間）
    let timeStr = text;
    for (const k of openKeywords) {
      if (timeStr.startsWith(k)) {
        timeStr = timeStr.slice(k.length).trim();
        break;
      }
    }

    if (session.deadlineTimer) {
      clearTimeout(session.deadlineTimer);
      session.deadlineTimer = null;
    }
    session.isOpen = true;
    session.openTime = new Date();
    session.orders = {};
    session.deadline = null;

    let replyText = '開始點餐！\n直接輸入餐點即可點餐！\nEX：雞腿便當（飯換菜）$110*3';

    if (timeStr) {
      const deadline = parseDeadlineTime(timeStr);
      if (!deadline) {
        await replyMessage(replyToken, { type: 'text', text: '時間格式錯誤，請輸入如：開單 11:30 或 開單11:30' });
        return;
      }
      const msUntil = deadline - Date.now();
      if (msUntil <= 0) {
        await replyMessage(replyToken, { type: 'text', text: '結單時間已過，請重新輸入！' });
        return;
      }
      session.deadline = deadline;
      session.deadlineTimer = setTimeout(() => autoClose(groupId), msUntil);
      replyText = `開始點餐！將於 ${formatTime(deadline)} 自動結單\n直接輸入餐點即可點餐！\nEX：雞腿便當（飯換菜）$110*3`;
    }

    await replyMessage(replyToken, { type: 'text', text: replyText });
    return;
  }

  // ── 11:30結單 → 未開單時觸發開單，已開單時只更新結單時間 ──
  const timeOnlyMatch = text.match(/^(\d{1,2}:\d{2})結單$/);
  if (timeOnlyMatch) {
    const deadline = parseDeadlineTime(timeOnlyMatch[1]);
    if (!deadline) {
      await replyMessage(replyToken, { type: 'text', text: '時間格式錯誤，請輸入如：11:30結單' });
      return;
    }
    const msUntil = deadline - Date.now();
    if (msUntil <= 0) {
      await replyMessage(replyToken, { type: 'text', text: '結單時間已過，請重新輸入！' });
      return;
    }
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    session.deadline = deadline;
    session.deadlineTimer = setTimeout(() => autoClose(groupId), msUntil);

    if (!session.isOpen) {
      // 未開單 → 同時觸發開單
      session.isOpen = true;
      session.openTime = new Date();
      session.orders = {};
      await replyMessage(replyToken, { type: 'text', text: `開始點餐！將於 ${formatTime(deadline)} 自動結單\n直接輸入餐點即可點餐！\nEX：雞腿便當（飯換菜）$110*3` });
    } else {
      // 已開單 → 只更新結單時間
      await replyMessage(replyToken, { type: 'text', text: `已更新結單時間：${formatTime(deadline)}` });
    }
    return;
  }

  // ── 結單 ──
  if (text === '結單' || text === '停止點餐') {
    if (session.deadlineTimer) {
      clearTimeout(session.deadlineTimer);
      session.deadlineTimer = null;
    }
    session.isOpen = false;
    const msgs = buildSummaryMessages(session, groupId);
    await replyMessage(replyToken, msgs);
    return;
  }

  // ── 查看目前訂單 ──
  if (['目前訂單', '查看訂單', '所有的訂單', '現在的訂單', '全部的訂單'].includes(text)) {
    const orderUserIds = Object.keys(session.orders).filter(uid => session.orders[uid].items.length > 0);
    if (orderUserIds.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '目前還沒有人點餐！' });
      return;
    }
    const status = session.isOpen ? '收單中' : '已結單';
    const deadlineStr = session.deadline ? `　結單：${formatTime(session.deadline)}` : '';
    let msg = `${status}${deadlineStr}\n\n目前訂單\n`;
    let total = 0;
    let totalQty = 0;
    for (const uid of orderUserIds) {
      const o = session.orders[uid];
      const itemStrs = o.items.map(item => {
        const priceStr = item.price !== null ? `${item.price}` : '';
        const qtyStr = `×${item.qty}`;
        const noteStr = item.note ? `（${item.note}）` : '';
        return `${item.name}${priceStr}${qtyStr}${noteStr}`;
      });
      const personTotal = o.items.reduce((s, i) => s + (i.price !== null ? i.price * i.qty : 0), 0);
      msg += `  ${o.name}：${itemStrs.join('、')}　小計 $${personTotal}\n`;
      total += personTotal;
      totalQty += o.items.reduce((s, i) => s + i.qty, 0);
    }
    msg += `\n共 ${orderUserIds.length} 人，${totalQty} 份\n總金額：$${total}`;
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 科室分裝便條紙 ──
  if (text === '科室分裝' || text === '依科室分單' || text === '科室分單') {
    const slipMsgs = buildSlipMessages(session, groupId);
    await replyMessage(replyToken, slipMsgs);
    return;
  }

  // ── 所有訂單（任何時候都可以查看）──
  if (text === '所有訂單' || text === '所有的訂單' || text === '全部的訂單') {
    const orderUserIds2 = Object.keys(session.orders).filter(uid => session.orders[uid].items.length > 0);
    if (orderUserIds2.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '目前還沒有任何訂單！' });
      return;
    }
    const status2 = session.isOpen ? '收單中' : '已結單';
    let msg = `${status2}\n\n全部訂單\n`;
    let total2 = 0;
    let totalQty2 = 0;
    for (const uid of orderUserIds2) {
      const o = session.orders[uid];
      const itemStrs = o.items.map(item => {
        const priceStr = item.price !== null ? `${item.price}` : '';
        const qtyStr = `×${item.qty}`;
        const noteStr = item.note ? `（${item.note}）` : '';
        return `${item.name}${priceStr}${qtyStr}${noteStr}`;
      });
      const personTotal = o.items.reduce((s, i) => s + (i.price !== null ? i.price * i.qty : 0), 0);
      msg += `  ${o.name}：${itemStrs.join('、')}　小計 $${personTotal}\n`;
      total2 += personTotal;
      totalQty2 += o.items.reduce((s, i) => s + i.qty, 0);
    }
    msg += `\n共 ${orderUserIds2.length} 人，${totalQty2} 份\n總金額：$${total2}`;
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 我的訂單 ──
  if (text === '我的訂單' || text === '我的餐點') {
    const o = session.orders[userId];
    if (!o || o.items.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '你還沒有點餐喔！' });
      return;
    }
    let msg = `${o.name} 的訂單：\n`;
    let total = 0;
    o.items.forEach((item, i) => {
      const priceStr = item.price !== null ? `${item.price}` : '';
      const qtyStr = `×${item.qty}`;
      const noteStr = item.note ? `（${item.note}）` : '';
      msg += `  ${i + 1}. ${item.name}${priceStr}${qtyStr}${noteStr}\n`;
      total += item.price !== null ? item.price * item.qty : 0;
    });
    msg += `小計：$${total}`;
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 以下只在開單期間有效 ──
  if (!session.isOpen) return;

  // ── # 開頭不記錄 ──
  if (text.startsWith('#')) return;

  // ── 輔助：顯示剩餘訂單 ──
  function showLeft(items) {
    if (items.length === 0) return '\n目前無其他訂單';
    const strs = items.map(i => {
      const p = i.price !== null ? `${i.price}` : '';
      const n = i.note ? `（${i.note}）` : '';
      return `${i.name}${n}${p}×${i.qty}`;
    });
    return `\n目前訂單：${strs.join('、')}`;
  }

  // ── 輔助：解析品項名稱和數量 ──
  function parseItemAndQty(str) {
    let itemName = str.trim();
    let qty = 1;
    let filterPrice = null;

    // 優先判斷 *數量 格式（明確表示數量）
    const starMatch = itemName.match(/^(.+)\s*[*×xX]\s*(\d+)$/);
    if (starMatch) {
      itemName = starMatch[1].trim();
      qty = parseInt(starMatch[2]);
      // 再從名稱結尾抓出價格
      const pm = itemName.match(/^(.+?)(\d+)$/);
      if (pm && pm[1].trim().length > 0) {
        filterPrice = parseInt(pm[2]);
        itemName = pm[1].trim();
      }
      return { itemName, qty, filterPrice };
    }

    // 判斷結尾有無 *數量 格式以外的數字
    // 規則：
    //   炸豬排110    → filterPrice=110（緊接名稱後面的數字是價格）
    //   炸豬排 110   → filterPrice=110（空格後數字也當價格，不當數量）
    //   炸豬排 110 2 → filterPrice=110, qty=2（最後一個數字是數量）
    //   取消 2       → qty=2（純數字當數量）

    // 先看有沒有「名稱 價格 數量」格式
    const fullMatch = itemName.match(/^(.+?)\s+(\d+)\s+(\d+)$/);
    if (fullMatch) {
      itemName = fullMatch[1].trim();
      filterPrice = parseInt(fullMatch[2]);
      qty = parseInt(fullMatch[3]);
      return { itemName, qty, filterPrice };
    }

    // 名稱緊接價格（無空格）：炸豬排110
    const noSpacePrice = itemName.match(/^(.+?)(\d+)$/);
    if (noSpacePrice && noSpacePrice[1].trim().length > 0) {
      // 確認名稱部分不是純數字
      const possibleName = noSpacePrice[1].trim();
      if (/\D/.test(possibleName)) {
        filterPrice = parseInt(noSpacePrice[2]);
        itemName = possibleName;
        return { itemName, qty, filterPrice };
      }
    }

    // 名稱+空格+數字：紅燒虱目魚肚 210 → 當價格不是數量
    const spacePrice = itemName.match(/^(.+)\s+(\d+)$/);
    if (spacePrice) {
      itemName = spacePrice[1].trim();
      filterPrice = parseInt(spacePrice[2]);
      return { itemName, qty, filterPrice };
    }

    return { itemName, qty, filterPrice };
  }

  // ── 取消我的訂單（自己所有）──
  if (text === '取消我的訂單' || text === '取消我的餐點') {
    if (session.orders[userId] && session.orders[userId].items.length > 0) {
      const myName = session.orders[userId].name;
      session.orders[userId].items = [];
      await replyMessage(replyToken, { type: 'text', text: `已取消 ${myName} 的所有訂單。` });
    } else {
      await replyMessage(replyToken, { type: 'text', text: '你還沒有點餐，無法取消。' });
    }
    return;
  }

  // ── 取消 @All 的OO 或 所有訂單 ──
  const cancelAllMatch = text.match(/^取消 @All[的 ](.+)$/);
  if (cancelAllMatch) {
    const target = cancelAllMatch[1].trim();
    if (target === '所有訂單') {
      for (const uid of Object.keys(session.orders)) {
        session.orders[uid].items = [];
      }
      await replyMessage(replyToken, { type: 'text', text: '已取消所有人的所有訂單。' });
    } else {
      const { itemName: allItem } = parseItemAndQty(target);
      let total = 0;
      const affectedNames = [];
      for (const uid of Object.keys(session.orders)) {
        const o2 = session.orders[uid];
        let i2 = o2.items.findIndex(i => i.name === allItem);
        if (i2 === -1) i2 = o2.items.findIndex(i => i.name.includes(allItem));
        if (i2 !== -1) {
          affectedNames.push(o2.name);
          o2.items.splice(i2, 1);
          total++;
        }
      }
      if (total > 0) {
        await replyMessage(replyToken, { type: 'text', text: `已取消所有人的「${allItem}」\n受影響（${total}人）：${affectedNames.join('、')}` });
      } else {
        await replyMessage(replyToken, { type: 'text', text: `找不到「${allItem}」，沒有人點這道。` });
      }
    }
    return;
  }

  // ── 取消 @小明 的OO 或 所有訂單 ──
  // 支援：取消 @小明的雞腿便當 或 取消 @小明 雞腿便當
  const cancelPersonMatch = text.match(/^取消 @(.+?)[的 ](.+)$/);
  if (cancelPersonMatch) {
    const targetName = cancelPersonMatch[1].trim();
    const targetItem = cancelPersonMatch[2].trim();

    // 找到目標人的 userId（只比對 LINE 原本名稱）
    let targetUid = null;
    for (const uid of Object.keys(session.orders)) {
      try {
        const url = groupId
          ? `https://api.line.me/v2/bot/group/${groupId}/member/${uid}`
          : `https://api.line.me/v2/profile/${uid}`;
        const res = await axios.get(url, {
          headers: { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` }
        });
        if (res.data.displayName === targetName) {
          targetUid = uid;
          break;
        }
      } catch { continue; }
    }

    if (!targetUid) {
      await replyMessage(replyToken, { type: 'text', text: `找不到「${targetName}」，請確認名稱是否正確。` });
      return;
    }

    const oTarget = session.orders[targetUid];

    if (targetItem === '所有訂單') {
      oTarget.items = [];
      await replyMessage(replyToken, { type: 'text', text: `已取消 ${targetName} 的所有訂單。` });
      return;
    }

    const { itemName: pItem, qty: pQty } = parseItemAndQty(targetItem);
    let pidx = oTarget.items.findIndex(i => i.name === pItem);
    if (pidx === -1) pidx = oTarget.items.findIndex(i => i.name.includes(pItem));
    if (pidx === -1) {
      await replyMessage(replyToken, { type: 'text', text: `找不到「${targetName}」的「${pItem}」。` });
      return;
    }

    const pTargetItem = oTarget.items[pidx];
    const pDisplayName = pTargetItem.note ? `${pTargetItem.name}（${pTargetItem.note}）` : pTargetItem.name;

    if (pQty >= pTargetItem.qty) {
      oTarget.items.splice(pidx, 1);
      await replyMessage(replyToken, { type: 'text', text: `已取消 ${targetName} 的：${pDisplayName}` });
    } else {
      pTargetItem.qty -= pQty;
      const pp = pTargetItem.price !== null ? `${pTargetItem.price}` : '';
      await replyMessage(replyToken, { type: 'text', text: `已取消 ${targetName} 的 ${pDisplayName} ${pQty} 份\n剩餘：${pTargetItem.name}${pp}×${pTargetItem.qty}` });
    }
    return;
  }

  // ── 取消所有OO（自己的某品項全部份數）──
  if (text.startsWith('取消所有') && text !== '取消所有訂單') {
    const o = session.orders[userId];
    if (!o || o.items.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '你還沒有點餐，無法取消。' });
      return;
    }
    const allItemName = text.replace(/^取消所有\s*/, '').trim();
    let aidx = o.items.findIndex(i => i.name === allItemName);
    if (aidx === -1) aidx = o.items.findIndex(i => i.name.includes(allItemName));
    if (aidx === -1) {
      await replyMessage(replyToken, { type: 'text', text: `找不到「${allItemName}」，請輸入「我的訂單」確認品項名稱。` });
      return;
    }
    const allItem2 = o.items[aidx];
    const allDisplay = allItem2.note ? `${allItem2.name}（${allItem2.note}）` : allItem2.name;
    o.items.splice(aidx, 1);
    await replyMessage(replyToken, { type: 'text', text: `已取消所有：${allDisplay}${showLeft(o.items)}` });
    return;
  }

  // ── 取消單筆 / 取消幾份（自己）──
  if (text.startsWith('取消')) {
    const o = session.orders[userId];
    if (!o || o.items.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '你還沒有點餐，無法取消。' });
      return;
    }

    let remaining = text.replace(/^取消\s*/, '').trim();
    const { itemName: cItem, qty: cQty, filterPrice: cPrice } = parseItemAndQty(remaining);

    // 檢查是否有「無價格」關鍵字
    let noPrice = false;
    let searchItem = cItem;
    if (cItem.endsWith(' 無價格') || cItem === '無價格') {
      noPrice = true;
      searchItem = cItem.replace(/\s*無價格$/, '').trim();
    }

    // 找出所有符合的品項（先完全符合，再包含比對）
    let matchedIdxs = [];
    o.items.forEach((i, idx) => { if (i.name === searchItem) matchedIdxs.push(idx); });
    if (matchedIdxs.length === 0) {
      o.items.forEach((i, idx) => { if (i.name.includes(searchItem)) matchedIdxs.push(idx); });
    }

    if (matchedIdxs.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: `找不到「${searchItem}」，請輸入「我的訂單」確認品項名稱。` });
      return;
    }

    // 若指定「無價格」，過濾出無價格的品項
    if (noPrice) {
      const nopriceFiltered = matchedIdxs.filter(idx => o.items[idx].price === null);
      if (nopriceFiltered.length === 0) {
        await replyMessage(replyToken, { type: 'text', text: `找不到無價格的「${searchItem}」。` });
        return;
      }
      matchedIdxs = nopriceFiltered;
    }

    // 若指定「無備註」，過濾出無備註的品項
    let noNote = false;
    if (searchItem.endsWith(' 無備註') || remaining.endsWith(' 無備註')) {
      noNote = true;
      searchItem = searchItem.replace(/\s*無備註$/, '').trim();
      matchedIdxs = matchedIdxs.filter(idx => !o.items[idx].note);
      if (matchedIdxs.length === 0) {
        await replyMessage(replyToken, { type: 'text', text: `找不到無備註的「${searchItem}」。` });
        return;
      }
    }

    // 若有多筆，先用價格過濾
    if (!noPrice && matchedIdxs.length > 1 && cPrice !== null) {
      const priceFiltered = matchedIdxs.filter(idx => o.items[idx].price === cPrice);
      if (priceFiltered.length > 0) matchedIdxs = priceFiltered;
    }

    // 若還是有多筆（相同價格但不同備註），顯示清單提示
    if (matchedIdxs.length > 1) {
      const lines = [];
      const exLines = [];
      matchedIdxs.forEach((idx, i) => {
        const it = o.items[idx];
        const priceStr = it.price !== null ? String(it.price) : '無價格';
        const noteStr = it.note ? `（${it.note}）` : '（無備註）';
        lines.push(`  ${i + 1}. ${it.name}${noteStr} ${priceStr}`);
        const exNote = it.note ? `（${it.note}）` : ' 無備註';
        const exPrice = it.price !== null ? String(it.price) : ' 無價格';
        exLines.push(`  取消 ${it.name}${exNote}${exPrice}`);
      });
      const listStr = [
        `找到 ${matchedIdxs.length} 筆「${searchItem}」，請加備註或價格區分：`,
        lines.join('\n'),
        '',
        'EX：',
        exLines.join('\n')
      ].join('\n');
      await replyMessage(replyToken, { type: 'text', text: listStr });
      return;
    }

    const cidx = matchedIdxs[0];
    const cTargetItem = o.items[cidx];
    const cDisplay = cTargetItem.note ? `${cTargetItem.name}（${cTargetItem.note}）` : cTargetItem.name;

    if (cQty >= cTargetItem.qty) {
      o.items.splice(cidx, 1);
    } else {
      cTargetItem.qty -= cQty;
    }

    // 統一顯示完整剩餘訂單
    const cancelMsg = cQty > 1 ? `已取消 ${cDisplay} ${cQty} 份` : `已取消：${cDisplay}`;
    await replyMessage(replyToken, { type: 'text', text: `${cancelMsg}${showLeft(o.items)}` });
    return;
  }

  // ── 修改價格 ──
  const priceChangeMatch = text.match(/^(.+?)改(\d+)元$/);
  if (priceChangeMatch) {
    const itemName = priceChangeMatch[1].trim();
    const newPrice = parseInt(priceChangeMatch[2]);
    const o = session.orders[userId];
    if (!o) return;
    const items = o.items.filter(i => i.name === itemName || i.name.includes(itemName));
    if (items.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: `找不到「${itemName}」，請輸入「我的訂單」確認品項名稱。` });
      return;
    }
    const oldPrice = items[0].price;
    items.forEach(i => i.price = newPrice);
    await replyMessage(replyToken, { type: 'text', text: `已更新價格：${itemName} $${oldPrice ?? 0} → $${newPrice}` });
    return;
  }

  // ── 修改數量 ──
  const qtyUnits = ['個', '份', '盒', '杯'];
  const qtyPattern = new RegExp(`^(.+?)改(\\d+)(${qtyUnits.join('|')})$`);
  const qtyChangeMatch = text.match(qtyPattern);
  if (qtyChangeMatch) {
    const itemName = qtyChangeMatch[1].trim();
    const newQty = parseInt(qtyChangeMatch[2]);
    const o = session.orders[userId];
    if (!o) return;
    const items = o.items.filter(i => i.name === itemName || i.name.includes(itemName));
    if (items.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: `找不到「${itemName}」，請輸入「我的訂單」確認品項名稱。` });
      return;
    }
    const oldQty = items[0].qty;
    items.forEach(i => i.qty = newQty);
    await replyMessage(replyToken, { type: 'text', text: `已更新數量：${itemName} ${oldQty}份 → ${newQty}份` });
    return;
  }

  // ── 全部加減價 ──
  const allPriceMatch = text.match(/^全部(加|減)(\d+)$/);
  if (allPriceMatch) {
    const op = allPriceMatch[1];
    const amount = parseInt(allPriceMatch[2]);
    for (const uid of Object.keys(session.orders)) {
      for (const item of session.orders[uid].items) {
        if (item.price !== null) {
          item.price = op === '加' ? item.price + amount : Math.max(0, item.price - amount);
        }
      }
    }
    await replyMessage(replyToken, { type: 'text', text: `已全部${op}價 $${amount}！\n輸入「目前訂單」查看更新後結果。` });
    return;
  }

  // ── 全部打折 ──
  const discountMatch = text.match(/^全部打(\d+(?:\.\d+)?)折$/);
  if (discountMatch) {
    const discount = parseFloat(discountMatch[1]) / 10;
    if (discount <= 0 || discount > 1) {
      await replyMessage(replyToken, { type: 'text', text: '折扣格式錯誤，例：全部打9折、全部打8.5折' });
      return;
    }
    for (const uid of Object.keys(session.orders)) {
      for (const item of session.orders[uid].items) {
        if (item.price !== null) {
          item.price = Math.round(item.price * discount);
        }
      }
    }
    await replyMessage(replyToken, { type: 'text', text: `已套用 ${discountMatch[1]} 折（小數點四捨五入）！\n輸入「目前訂單」查看更新後結果。` });
    return;
  }

  // ── 點餐（支援多行一次點多道）──
  // 將訊息依換行切分，每行各自解析為獨立餐點
  const orderLines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // 取得 LINE 原本名稱（用來比對待綁定設定）
  const lineName = await getMemberName(groupId, userId);

  // 檢查是否有待綁定的暱稱設定
  if (!nicknames[userId] && pendingNicknames[lineName]) {
    nicknames[userId] = pendingNicknames[lineName];
    delete pendingNicknames[lineName];
  }

  // 最終顯示名稱：優先用代號，沒有代號才用 LINE 名稱
  let name = nicknames[userId] || lineName;

  if (!session.orders[userId]) {
    session.orders[userId] = { name, dept: depts[userId] || null, items: [] };
  }
  session.orders[userId].name = name;

  // 檢查是否有待綁定的科室設定
  if (!depts[userId]) {
    if (pendingDepts[name]) {
      depts[userId] = pendingDepts[name];
      delete pendingDepts[name];
    } else if (pendingDepts[lineName]) {
      depts[userId] = pendingDepts[lineName];
      delete pendingDepts[lineName];
    }
  }
  session.orders[userId].dept = depts[userId] || null;

  // 逐行解析餐點
  const addedItems = [];
  for (const line of orderLines) {
    const parsed = parseOrderText(line);
    if (!parsed.itemName) continue;
    session.orders[userId].items.push({
      name: parsed.itemName,
      price: parsed.price,
      note: parsed.note,
      qty: parsed.qty
    });
    addedItems.push(parsed);
  }

  if (addedItems.length === 0) return;

  // 回覆確認（多行時列出所有點的餐點）
  let confirmText = '';
  if (addedItems.length === 1) {
    const p = addedItems[0];
    const priceStr = p.price !== null ? ` $${p.price * p.qty}` : '';
    const qtyStr = p.qty > 1 ? ` x${p.qty}` : '';
    const noteStr = p.note ? `（${p.note}）` : '';
    confirmText = `✅ ${name} 點了：${p.itemName}${noteStr}${qtyStr}${priceStr}`;
  } else {
    confirmText = `✅ ${name} 點了：\n`;
    for (const p of addedItems) {
      const priceStr = p.price !== null ? ` $${p.price * p.qty}` : '';
      const qtyStr = p.qty > 1 ? ` x${p.qty}` : '';
      const noteStr = p.note ? `（${p.note}）` : '';
      confirmText += `  ${p.itemName}${noteStr}${qtyStr}${priceStr}\n`;
    }
    confirmText = confirmText.trim();
  }

  // 回覆確認
  const priceStr = ''; const qtyStr = ''; const noteStr = '';
  await replyMessage(replyToken, {
    type: 'text',
    text: confirmText
  });
}

// ===== 新成員加入提醒 =====
async function handleMemberJoin(event) {
  if (event.type !== 'memberJoined') return;
  const groupId = event.source.groupId;
  for (const member of event.joined.members) {
    if (member.type === 'user') {
      const name = await getMemberName(groupId, member.userId);
      try {
        await pushMessage(groupId, {
          type: 'text',
          text: `歡迎 ${name} 加入！\n請輸入「設定科室 你的部門」完成設定\n例：設定科室 行政部`
        });
      } catch (e) {
        console.error('Member join push error:', e.message);
      }
    }
  }
}

// ===== Webhook =====
app.use('/webhook', express.raw({ type: '*/*' }));

app.post('/webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];
  const hmac = crypto.createHmac('sha256', CHANNEL_SECRET);
  hmac.update(req.body);
  if (signature !== hmac.digest('base64')) {
    return res.status(403).send('Forbidden');
  }

  res.status(200).send('OK');

  const body = JSON.parse(req.body.toString());
  for (const event of body.events) {
    try {
      if (event.type === 'message') await handleMessage(event);
      if (event.type === 'memberJoined') await handleMemberJoin(event);
    } catch (e) {
      console.error('Event error:', e.message);
    }
  }
});

app.get('/', (req, res) => res.send('LINE 訂餐機器人運作中'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
