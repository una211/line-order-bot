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
// sessions[groupId] = { isOpen, openTime, deadline, deadlineTimer, orders }
// orders[userId] = { name, dept, items: [{ name, price, note, qty }] }
const sessions = {};
const deptSettings = {}; // deptSettings[groupId][userId] = '行政部'

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

function formatTime(date) {
  if (!date) return '';
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// ===== 解析點餐訊息 =====
// 支援格式：
//   雞腿便當 80
//   雞腿便當（少冰）80
//   雞腿便當 備註 少冰
//   雞腿便當 80（少冰）
function parseOrderText(text) {
  let itemName = text.trim();
  let price = null;
  let note = null;
  let qty = 1;

  // 抓括號備註：（xxx）或 (xxx)
  const bracketMatch = itemName.match(/[（(]([^）)]+)[）)]/);
  if (bracketMatch) {
    note = bracketMatch[1].trim();
    itemName = itemName.replace(bracketMatch[0], '').trim();
  }

  // 抓「備註」關鍵字備註
  const noteKeywordMatch = itemName.match(/^(.+?)\s+備註\s+(.+)$/);
  if (noteKeywordMatch) {
    itemName = noteKeywordMatch[1].trim();
    note = noteKeywordMatch[2].trim();
  }

  // 抓價格（結尾數字，前面可有 $ 或空格）
  const priceMatch = itemName.match(/^(.+?)\s+\$?(\d+)$/);
  if (priceMatch) {
    itemName = priceMatch[1].trim();
    price = parseInt(priceMatch[2]);
  }

  return { itemName, price, note, qty };
}

// ===== 建立結單訊息（2則）=====
function buildSummaryMessages(session, groupId, closedTime) {
  const orders = session.orders;
  const userIds = Object.keys(orders).filter(uid => orders[uid].items.length > 0);
  const depts = getDeptSettings(groupId);

  if (userIds.length === 0) {
    return [{ type: 'text', text: '📋 本輪沒有任何訂單。' }];
  }

  const openTimeStr = session.openTime ? formatTime(session.openTime) : '';
  const closeTimeStr = closedTime ? formatTime(closedTime) : formatTime(new Date());
  const timeStr = `⏰ 開單：${openTimeStr}　結單：${closeTimeStr}`;

  // ===== 第1則：依品項統計 =====
  const itemMap = {}; // { itemName: { qty, totalPrice, hasPrice } }
  for (const uid of userIds) {
    for (const item of orders[uid].items) {
      if (!itemMap[item.name]) {
        itemMap[item.name] = { qty: 0, totalPrice: 0, hasPrice: false };
      }
      itemMap[item.name].qty += item.qty;
      if (item.price !== null) {
        itemMap[item.name].totalPrice += item.price * item.qty;
        itemMap[item.name].hasPrice = true;
      }
    }
  }

  let totalAmount = 0;
  let totalQty = 0;
  let msg1 = `🔒 已結單！\n${timeStr}\n\n`;
  msg1 += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg1 += `🍱 第1則：依品項統計\n`;
  msg1 += `━━━━━━━━━━━━━━━━━━━━\n`;

  for (const [name, data] of Object.entries(itemMap)) {
    const priceStr = data.hasPrice ? `　小計 $${data.totalPrice}` : `　小計 $0`;
    msg1 += `  ${name} × ${data.qty}${priceStr}\n`;
    totalAmount += data.hasPrice ? data.totalPrice : 0;
    totalQty += data.qty;
  }

  msg1 += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg1 += `👥 共 ${userIds.length} 人，${totalQty} 份\n`;
  msg1 += `💰 總金額：$${totalAmount} 元`;

  // ===== 第2則：依科室統計 =====
  // 分組
  const deptMap = {}; // { deptName: [ { name, items } ] }
  const noDept = [];

  for (const uid of userIds) {
    const o = orders[uid];
    const dept = depts[uid] || null;
    const entry = { name: o.name, items: o.items };
    if (dept) {
      if (!deptMap[dept]) deptMap[dept] = [];
      deptMap[dept].push(entry);
    } else {
      noDept.push(entry);
    }
  }

  let msg2 = `━━━━━━━━━━━━━━━━━━━━\n`;
  msg2 += `🏢 第2則：依科室統計\n`;
  msg2 += `━━━━━━━━━━━━━━━━━━━━\n`;

  const formatPersonItems = (items) => {
    return items.map(item => {
      const qtyStr = item.qty > 1 ? ` x${item.qty}` : '';
      const noteStr = item.note ? `（${item.note}）` : '';
      const priceStr = item.price !== null ? ` $${item.price * item.qty}` : ` $0`;
      return `${item.name}${qtyStr}${noteStr}${priceStr}`;
    }).join('、');
  };

  for (const [dept, members] of Object.entries(deptMap)) {
    const deptTotal = members.reduce((sum, m) =>
      sum + m.items.reduce((s, i) => s + (i.price !== null ? i.price * i.qty : 0), 0), 0);
    msg2 += `\n🏢 ${dept}（${members.length}人）\n`;
    for (const m of members) {
      msg2 += `  ${m.name}：${formatPersonItems(m.items)}\n`;
    }
    msg2 += `  小計：$${deptTotal}\n`;
  }

  if (noDept.length > 0) {
    const noDeptTotal = noDept.reduce((sum, m) =>
      sum + m.items.reduce((s, i) => s + (i.price !== null ? i.price * i.qty : 0), 0), 0);
    msg2 += `\n📦 未設定科室（${noDept.length}人）\n`;
    for (const m of noDept) {
      msg2 += `  ${m.name}：${formatPersonItems(m.items)}\n`;
    }
    msg2 += `  小計：$${noDeptTotal}\n`;
    msg2 += `\n⚠️ 以上 ${noDept.length} 人尚未設定科室\n請輸入「設定科室 你的部門」`;
  }

  return [
    { type: 'text', text: msg1 },
    { type: 'text', text: msg2 }
  ];
}

// ===== 自動結單 =====
async function autoClose(groupId) {
  const session = getSession(groupId);
  session.isOpen = false;
  session.deadlineTimer = null;
  const msgs = buildSummaryMessages(session, groupId, new Date());
  try {
    await pushMessage(groupId, msgs);
  } catch (e) {
    console.error('Auto close push error:', e.message);
  }
}

// ===== 解析結單時間 =====
function parseDeadlineTime(timeStr) {
  // 支援 "11:30" 或 "11:30結單"
  const match = timeStr.replace('結單', '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = parseInt(match[1]);
  const m = parseInt(match[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  const deadline = new Date();
  deadline.setHours(h, m, 0, 0);
  return deadline;
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

  // ── 設定科室 ──
  if (text.startsWith('設定科室')) {
    const dept = text.replace('設定科室', '').trim();
    if (!dept) {
      await replyMessage(replyToken, { type: 'text', text: '請輸入科室名稱，例：設定科室 行政部' });
      return;
    }
    depts[userId] = dept;
    const name = await getMemberName(groupId, userId);
    await replyMessage(replyToken, { type: 'text', text: `✅ 已設定 ${name} 的科室為「${dept}」` });
    return;
  }

  // ── 查看科室設定 ──
  if (text === '科室設定' || text === '查看科室') {
    const entries = Object.entries(depts);
    if (entries.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '目前沒有任何科室設定。\n請輸入「設定科室 你的部門」' });
      return;
    }
    let msg = '🏢 目前科室設定：\n';
    for (const [uid, dept] of entries) {
      const name = await getMemberName(groupId, uid);
      msg += `  ${name} → ${dept}\n`;
    }
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 說明 ──
  if (['說明', 'help', '？', '?'].includes(text.toLowerCase())) {
    const help = `🍔 訂餐機器人指令說明
═══════════════════
📌 開單
  開單 11:30
  開始訂餐 11:30
  （不附時間則手動結單）

🛒 點餐（開單後直接輸入）
  雞腿便當 80
  雞腿便當（少冰）80
  雞腿便當 備註 少冰 80

✏️ 修改
  取消 雞腿便當
  取消全部
  雞腿便當改60元
  雞腿便當改2份
  全部加5
  全部減5
  全部打9折

👀 查看
  我的訂單
  目前訂單

🔚 結單
  結單
  11:30結單

🏢 科室
  設定科室 行政部
  查看科室

💬 開單期間 # 開頭不記錄
  #今天吃什麼？`;
    await replyMessage(replyToken, { type: 'text', text: help });
    return;
  }

  // ── 開單 ──
  const openKeywords = ['開單', '開始訂餐', '開始點餐'];
  const isOpenCmd = openKeywords.some(k => text.startsWith(k));
  if (isOpenCmd) {
    // 取出時間部分
    let timeStr = text;
    for (const k of openKeywords) {
      timeStr = timeStr.replace(k, '').trim();
    }

    // 清除上一輪
    if (session.deadlineTimer) {
      clearTimeout(session.deadlineTimer);
      session.deadlineTimer = null;
    }
    session.isOpen = true;
    session.openTime = new Date();
    session.orders = {};
    session.deadline = null;

    let replyText = '✅ 訂餐開始！\n\n直接輸入餐點名稱即可點餐！\n加備註：雞腿便當（少冰）80\n輸入「說明」查看所有指令。';

    if (timeStr) {
      const deadline = parseDeadlineTime(timeStr);
      if (!deadline) {
        await replyMessage(replyToken, { type: 'text', text: '❌ 時間格式錯誤，請輸入如：開單 11:30' });
        return;
      }
      const msUntil = deadline - Date.now();
      if (msUntil <= 0) {
        await replyMessage(replyToken, { type: 'text', text: '❌ 結單時間已過，請重新輸入！' });
        return;
      }
      session.deadline = deadline;
      session.deadlineTimer = setTimeout(() => autoClose(groupId), msUntil);
      replyText = `✅ 訂餐開始！⏰ 將於 ${formatTime(deadline)} 自動結單\n\n直接輸入餐點名稱即可點餐！\n加備註：雞腿便當（少冰）80\n輸入「說明」查看所有指令。`;
    }

    await replyMessage(replyToken, { type: 'text', text: replyText });
    return;
  }

  // ── 單獨設定結單時間 EX: 11:30結單 ──
  const timeOnlyMatch = text.match(/^(\d{1,2}:\d{2})結單$/);
  if (timeOnlyMatch) {
    const deadline = parseDeadlineTime(timeOnlyMatch[1]);
    if (!deadline) {
      await replyMessage(replyToken, { type: 'text', text: '❌ 時間格式錯誤，請輸入如：11:30結單' });
      return;
    }
    const msUntil = deadline - Date.now();
    if (msUntil <= 0) {
      await replyMessage(replyToken, { type: 'text', text: '❌ 結單時間已過，請重新輸入！' });
      return;
    }
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    session.deadline = deadline;
    session.deadlineTimer = setTimeout(() => autoClose(groupId), msUntil);
    await replyMessage(replyToken, { type: 'text', text: `✅ 已設定結單時間：${formatTime(deadline)}` });
    return;
  }

  // ── 結單 ──
  if (text === '結單' || text === '停止點餐') {
    if (session.deadlineTimer) {
      clearTimeout(session.deadlineTimer);
      session.deadlineTimer = null;
    }
    session.isOpen = false;
    const msgs = buildSummaryMessages(session, groupId, new Date());
    await replyMessage(replyToken, msgs);
    return;
  }

  // ── 查看目前訂單 ──
  if (text === '目前訂單' || text === '查看訂單') {
    const orders = session.orders;
    const userIds = Object.keys(orders).filter(uid => orders[uid].items.length > 0);
    if (userIds.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '目前還沒有人點餐！' });
      return;
    }
    const status = session.isOpen ? '📂 收單中' : '🔒 已結單';
    const deadlineStr = session.deadline ? `　⏰ 結單：${formatTime(session.deadline)}` : '';
    let msg = `${status}${deadlineStr}\n\n📋 目前訂單\n─────────────\n`;
    let total = 0;
    let totalQty = 0;
    for (const uid of userIds) {
      const o = orders[uid];
      const itemStrs = o.items.map(item => {
        const qtyStr = item.qty > 1 ? ` x${item.qty}` : '';
        const noteStr = item.note ? `（${item.note}）` : '';
        const priceStr = item.price !== null ? ` $${item.price * item.qty}` : ' $0';
        return `${item.name}${qtyStr}${noteStr}${priceStr}`;
      });
      const personTotal = o.items.reduce((s, i) => s + (i.price !== null ? i.price * i.qty : 0), 0);
      msg += `  ${o.name}：${itemStrs.join('、')}　小計 $${personTotal}\n`;
      total += personTotal;
      totalQty += o.items.reduce((s, i) => s + i.qty, 0);
    }
    msg += `─────────────\n👥 共 ${userIds.length} 人，${totalQty} 份\n💰 目前總金額：$${total}`;
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 我的訂單 ──
  if (text === '我的訂單') {
    const o = session.orders[userId];
    if (!o || o.items.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: '你還沒有點餐喔！' });
      return;
    }
    let msg = `📋 ${o.name} 的訂單：\n`;
    let total = 0;
    o.items.forEach((item, i) => {
      const qtyStr = item.qty > 1 ? ` x${item.qty}` : '';
      const noteStr = item.note ? `（${item.note}）` : '';
      const priceStr = item.price !== null ? ` $${item.price * item.qty}` : ' $0';
      msg += `  ${i + 1}. ${item.name}${qtyStr}${noteStr}${priceStr}\n`;
      total += item.price !== null ? item.price * item.qty : 0;
    });
    msg += `小計：$${total}`;
    await replyMessage(replyToken, { type: 'text', text: msg });
    return;
  }

  // ── 以下指令只在開單期間有效 ──
  if (!session.isOpen) return;

  // ── # 開頭不記錄 ──
  if (text.startsWith('#')) return;

  // ── 取消全部 ──
  if (text === '取消全部') {
    if (session.orders[userId]) {
      session.orders[userId].items = [];
      const name = session.orders[userId].name;
      await replyMessage(replyToken, { type: 'text', text: `✅ 已取消 ${name} 的所有訂單。` });
    }
    return;
  }

  // ── 取消單筆 ──
  if (text.startsWith('取消 ')) {
    const itemName = text.replace('取消 ', '').trim();
    const o = session.orders[userId];
    if (!o || o.items.length === 0) return;
    const idx = o.items.findIndex(i => i.name === itemName || i.name.includes(itemName));
    if (idx === -1) {
      await replyMessage(replyToken, { type: 'text', text: `❌ 找不到「${itemName}」，請輸入「我的訂單」確認品項名稱。` });
      return;
    }
    o.items.splice(idx, 1);
    await replyMessage(replyToken, { type: 'text', text: `✅ 已取消：${itemName}` });
    return;
  }

  // ── 修改價格 EX: 雞腿便當改60元 ──
  const priceChangeMatch = text.match(/^(.+?)改(\d+)元$/);
  if (priceChangeMatch) {
    const itemName = priceChangeMatch[1].trim();
    const newPrice = parseInt(priceChangeMatch[2]);
    const o = session.orders[userId];
    if (!o) return;
    const items = o.items.filter(i => i.name === itemName || i.name.includes(itemName));
    if (items.length === 0) {
      await replyMessage(replyToken, { type: 'text', text: `❌ 找不到「${itemName}」，請輸入「我的訂單」確認品項名稱。` });
      return;
    }
    const oldPrice = items[0].price;
    items.forEach(i => i.price = newPrice);
    await replyMessage(replyToken, { type: 'text', text: `✅ 已更新價格：${itemName} $${oldPrice ?? 0} → $${newPrice}` });
    return;
  }

  // ── 修改數量 EX: 雞腿便當改2份 ──
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
      await replyMessage(replyToken, { type: 'text', text: `❌ 找不到「${itemName}」，請輸入「我的訂單」確認品項名稱。` });
      return;
    }
    const oldQty = items[0].qty;
    items.forEach(i => i.qty = newQty);
    await replyMessage(replyToken, { type: 'text', text: `✅ 已更新數量：${itemName} ${oldQty}份 → ${newQty}份` });
    return;
  }

  // ── 全部加價 / 減價 ──
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
    await replyMessage(replyToken, { type: 'text', text: `✅ 已全部${op}價 $${amount}！\n輸入「目前訂單」查看更新後結果。` });
    return;
  }

  // ── 全部打折 ──
  const discountMatch = text.match(/^全部打(\d+(?:\.\d+)?)折$/);
  if (discountMatch) {
    const discount = parseFloat(discountMatch[1]) / 10;
    if (discount <= 0 || discount > 1) {
      await replyMessage(replyToken, { type: 'text', text: '❌ 折扣格式錯誤，例：全部打9折、全部打8.5折' });
      return;
    }
    for (const uid of Object.keys(session.orders)) {
      for (const item of session.orders[uid].items) {
        if (item.price !== null) {
          item.price = Math.round(item.price * discount);
        }
      }
    }
    await replyMessage(replyToken, { type: 'text', text: `✅ 已套用 ${discountMatch[1]} 折（小數點四捨五入）！\n輸入「目前訂單」查看更新後結果。` });
    return;
  }

  // ── 點餐 ──
  const { itemName, price, note } = parseOrderText(text);

  if (!itemName) return;

  const name = await getMemberName(groupId, userId);
  if (!session.orders[userId]) {
    session.orders[userId] = {
      name,
      dept: depts[userId] || null,
      items: []
    };
  }
  session.orders[userId].name = name;
  session.orders[userId].dept = depts[userId] || null;

  session.orders[userId].items.push({
    name: itemName,
    price: price,
    note: note,
    qty: 1
  });

  // 靜默記錄，不回應
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
          text: `👋 歡迎 ${name} 加入！\n請輸入「設定科室 你的部門」完成設定\n例：設定科室 行政部`
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

app.get('/', (req, res) => res.send('LINE 訂餐機器人運作中 🍔'));

const PORT = process.env.PORT || 1000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
