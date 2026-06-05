/**
 * 🎫 周杰伦北京演唱会 - 高频云端监控脚本
 * 
 * 持续运行（每次最长6小时），每3秒检查一次
 * 专为捡漏设计——退票秒级检测，微信即时通知
 * 
 * GitHub Actions 公开仓库免费无限运行
 */

const https = require('https');
const http = require('http');

// ==================== 配置 ====================

const CONFIG = {
  serverChanKey: process.env.SERVER_CHAN_KEY || '',

  targetDate: '2026-06-28',
  targetShow: '周杰伦2026嘉年华北京演唱会',

  // 检查间隔（毫秒）
  checkInterval: 3000,

  // 最长运行时间（毫秒）—— 5.5小时，给下次 cron 触发留缓冲
  maxRuntime: 5.5 * 60 * 60 * 1000,

  // 通知冷却时间（毫秒）—— 防止重复通知轰炸
  notifyCooldown: 5 * 60 * 1000,

  // 心跳间隔（毫秒）—— 每30分钟输出一次状态
  heartbeatInterval: 30 * 60 * 1000,

  // 大麦
  damai: {
    mPageUrl: 'https://m.damai.cn/damai/detail/item.html?itemId=1055320817964',
  },

  // 猫眼
  maoyan: {
    showUrl: 'https://m.maoyan.com/shows/326846',
  },
};

// ==================== 运行时状态 ====================

const STATE = {
  startTime: Date.now(),
  checkCount: 0,
  lastNotifyTime: 0,
  lastHeartbeat: Date.now(),
  damaiLastHit: false,
  maoyanLastHit: false,
};

// ==================== 工具函数 ====================

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').slice(11, 19);
  const prefix = { INFO: ' ', OK: '✅', WARN: '⚠️', ERROR: '❌', FOUND: '🔔', STATS: '📊' };
  console.log(`[${ts}] ${prefix[level] || ''} ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * HTTP GET 请求
 */
function httpGet(url, headers = {}) {
  return new Promise((resolve) => {
    try {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.0',
          'Accept': 'text/html,application/json,application/xhtml+xml,*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          ...headers,
        },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', (err) => resolve({ status: 0, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: '超时' }); });
    } catch (err) {
      resolve({ status: 0, error: err.message });
    }
  });
}

// ==================== 微信通知 ====================

async function sendWechatNotification(title, content) {
  if (!CONFIG.serverChanKey) return false;

  // 冷却检查
  const now = Date.now();
  if (now - STATE.lastNotifyTime < CONFIG.notifyCooldown) {
    log(`通知冷却中，跳过（距上次 ${Math.floor((now - STATE.lastNotifyTime) / 1000)}秒）`, 'WARN');
    return false;
  }
  STATE.lastNotifyTime = now;

  try {
    const desp = `${content}\n\n---\n⏰ 检测时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n🔄 已检测次数：${STATE.checkCount}\n🤖 云端高频监控`;
    const postData = JSON.stringify({ title, desp });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'sctapi.ftqq.com',
        port: 443,
        path: `/${CONFIG.serverChanKey}.send`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 10000,
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const r = JSON.parse(d);
            const ok = r.code === 0 || (r.data && r.data.error === 'SUCCESS');
            log(ok ? '📱 微信通知已发送！' : `通知异常：${d}`, ok ? 'FOUND' : 'WARN');
            resolve(ok);
          } catch { resolve(false); }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.write(postData);
      req.end();
    });
  } catch { return false; }
}

// ==================== 大麦检测 ====================

async function checkDamai() {
  try {
    const result = await httpGet(CONFIG.damai.mPageUrl, {
      'Referer': 'https://m.damai.cn/',
      'Cookie': 'damai_cn_nav=1',
    });
    if (result.error) return { sellable: false, text: `请求失败: ${result.error}` };

    const html = result.body;

    // 关键检测词
    const onSale = /立即购买|选座购买|马上抢|btn-buy|buy-btn/i.test(html);
    const appOnly = /请到大麦App|请下载大麦|打开App购买|applogo/i.test(html);
    const soldOut = /已售罄|售罄|卖完了/i.test(html);
    const notStarted = /即将开售|即将开始|倒计时|预售/i.test(html);

    let sellable = false;
    let text = '';

    if (onSale && !appOnly) {
      text = '🎉 可购买！';
      sellable = true;
    } else if (onSale && appOnly) {
      text = '📱 App端可购';
      sellable = true;
    } else if (soldOut) {
      text = '已售罄';
    } else if (notStarted) {
      text = '即将开售';
    } else {
      text = '未知';
    }

    return { sellable, text };
  } catch {
    return { sellable: false, text: '异常' };
  }
}

// ==================== 猫眼检测 ====================

async function checkMaoyan() {
  try {
    const result = await httpGet(CONFIG.maoyan.showUrl, {
      'Referer': 'https://m.maoyan.com/',
    });
    if (result.error) return { sellable: false, text: `请求失败: ${result.error}` };

    const html = result.body;

    const onSale = /立即购买|选座购买|马上抢|去购票|buyBtn|buy-now/i.test(html);
    const soldOut = /已售罄|售罄|卖完了/i.test(html);
    const notStarted = /即将开售|即将开始|预售/i.test(html);

    let sellable = false;
    let text = '';

    if (onSale) {
      text = '🎉 可购买！';
      sellable = true;
    } else if (soldOut) {
      text = '已售罄';
    } else if (notStarted) {
      text = '即将开售';
    } else {
      text = '未知';
    }

    return { sellable, text };
  } catch {
    return { sellable: false, text: '异常' };
  }
}

// ==================== 心跳 ====================

function heartbeat() {
  const now = Date.now();
  if (now - STATE.lastHeartbeat < CONFIG.heartbeatInterval) return;
  STATE.lastHeartbeat = now;

  const runtime = Math.floor((now - STATE.startTime) / 60000);
  const rate = Math.floor(STATE.checkCount / Math.max(runtime, 1));
  
  log(`💓 心跳 | 运行: ${runtime}分钟 | 检查: ${STATE.checkCount}次 | 频率: ${rate}次/分`, 'STATS');
}

// ==================== 主循环 ====================

async function main() {
  console.log('\n' + '='.repeat(50));
  console.log('🎫 周杰伦北京演唱会 - 高频云端监控');
  console.log('='.repeat(50));
  console.log(`📅 目标：${CONFIG.targetDate} | 🎤 ${CONFIG.targetShow}`);
  console.log('⚡ 模式：持续高频（每3秒检查）');
  console.log(`⏱️ 最长运行：5.5小时（之后自动重启）`);
  console.log(`⚠️ 通知冷却：5分钟（防止重复）`);
  console.log(`☁️ 运行环境：${process.env.GITHUB_ACTIONS ? 'GitHub Actions' : '本地测试'}`);
  console.log(`⏰ 启动时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log('='.repeat(50) + '\n');

  if (!CONFIG.serverChanKey || CONFIG.serverChanKey === 'YOUR_SEND_KEY_HERE') {
    log('未配置 SERVER_CHAN_KEY，无法发送微信通知', 'ERROR');
    process.exit(1);
  }

  log('🚀 开始捡漏监控...', 'OK');

  let lastDamaiStatus = '';
  let lastMaoyanStatus = '';

  while (true) {
    // 超时检查
    if (Date.now() - STATE.startTime > CONFIG.maxRuntime) {
      log(`⏰ 已运行 ${Math.floor(CONFIG.maxRuntime/3600000)} 小时，优雅退出（下次 cron 会自动重启）`, 'OK');
      process.exit(0);
    }

    STATE.checkCount++;

    // 并发检查两个平台
    const [damai, maoyan] = await Promise.all([
      checkDamai(),
      checkMaoyan(),
    ]);

    // 状态变化才输出日志（减少噪音）
    if (damai.text !== lastDamaiStatus) {
      log(`🎫 大麦：${damai.text}`, damai.sellable ? 'FOUND' : 'INFO');
      lastDamaiStatus = damai.text;
    }
    if (maoyan.text !== lastMaoyanStatus) {
      log(`🐱 猫眼：${maoyan.text}`, maoyan.sellable ? 'FOUND' : 'INFO');
      lastMaoyanStatus = maoyan.text;
    }

    // 发现可售 → 微信通知
    if (damai.sellable && !STATE.damaiLastHit) {
      await sendWechatNotification(
        '🎫【大麦有票！】周杰伦北京6月28日',
        `**场次：** ${CONFIG.targetDate} 19:00\n**平台：** 大麦网\n**状态：** ${damai.text}\n\n⚡ **立即打开大麦App抢票！**\n\n> 高频监控脚本检测到可购票状态`
      );
      STATE.damaiLastHit = true;
    }
    if (maoyan.sellable && !STATE.maoyanLastHit) {
      await sendWechatNotification(
        '🐱【猫眼有票！】周杰伦北京6月28日',
        `**场次：** ${CONFIG.targetDate} 19:00\n**平台：** 猫眼\n**状态：** ${maoyan.text}\n\n⚡ **立即打开猫眼App抢票！**\n\n> 高频监控脚本检测到可购票状态`
      );
      STATE.maoyanLastHit = true;
    }

    // 重置命中标记（票被抢走后再检测到会重新通知）
    if (!damai.sellable) STATE.damaiLastHit = false;
    if (!maoyan.sellable) STATE.maoyanLastHit = false;

    // 心跳
    heartbeat();

    // 等待后继续
    await sleep(CONFIG.checkInterval);
  }
}

main().catch(err => {
  log(`致命错误：${err.message}`, 'ERROR');
  console.error(err);
  process.exit(1);
});
