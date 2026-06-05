/**
 * 🎫 周杰伦北京演唱会 - 云端监控脚本
 * 
 * 部署到 GitHub Actions，每2分钟自动运行
 * 检测到大麦或猫眼开售 → 通过Server酱发送微信通知
 * 
 * 电脑关机也不影响，24小时云端运行！
 */

const https = require('https');
const http = require('http');

// ==================== 配置 ====================

const CONFIG = {
  // Server酱 SendKey（微信通知）
  serverChanKey: process.env.SERVER_CHAN_KEY || '',

  // 监控目标
  targetDate: '2026-06-28',
  targetShow: '周杰伦2026嘉年华北京演唱会',

  // 大麦配置
  damai: {
    itemId: '1055320817964',
    pageUrl: 'https://detail.damai.cn/item.htm?id=1055320817964',
    mPageUrl: 'https://m.damai.cn/damai/detail/item.html?itemId=1055320817964',
  },

  // 猫眼配置
  maoyan: {
    searchUrl: 'https://m.maoyan.com/ajax/search?keyword=%E5%91%A8%E6%9D%B0%E4%BC%A6&cityId=10&stype=2&limit=10',
    showUrl: 'https://m.maoyan.com/shows/326846',
  },
};

// ==================== 工具函数 ====================

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const prefix = { INFO: '📋', OK: '✅', WARN: '⚠️', ERROR: '❌', FOUND: '🔔' };
  console.log(`[${ts}] ${prefix[level] || '📋'} ${msg}`);
}

/**
 * 发送HTTP GET请求
 */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

/**
 * 通过Server酱发送微信通知
 */
async function sendWechatNotification(title, content) {
  if (!CONFIG.serverChanKey || CONFIG.serverChanKey === 'YOUR_SEND_KEY_HERE') {
    log('未配置 Server酱 SendKey，跳过微信通知', 'WARN');
    return false;
  }

  try {
    const desp = `${content}\n\n---\n⏰ 检测时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n🤖 由云端监控脚本自动发送`;
    const postData = JSON.stringify({
      title: title,
      desp: desp,
    });

    const options = {
      hostname: 'sctapi.ftqq.com',
      port: 443,
      path: `/${CONFIG.serverChanKey}.send`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 15000,
    };

    return new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const resp = JSON.parse(data);
            if (resp.code === 0 || (resp.data && resp.data.error === 'SUCCESS')) {
              log('微信通知发送成功！', 'OK');
              resolve(true);
            } else {
              log(`微信通知返回：${data}`, 'WARN');
              resolve(false);
            }
          } catch {
            log(`微信通知响应解析失败：${data}`, 'WARN');
            resolve(false);
          }
        });
      });
      req.on('error', (err) => { log(`微信通知发送异常：${err.message}`, 'ERROR'); resolve(false); });
      req.on('timeout', () => { req.destroy(); log('微信通知发送超时', 'ERROR'); resolve(false); });
      req.write(postData);
      req.end();
    });
  } catch (err) {
    log(`微信通知异常：${err.message}`, 'ERROR');
    return false;
  }
}

// ==================== 大麦检测 ====================

async function checkDamai() {
  log('🔍 检查大麦...');
  
  try {
    // 尝试移动端页面（信息更全）
    const result = await httpGet(CONFIG.damai.mPageUrl, {
      'Referer': 'https://m.damai.cn/',
    });

    const html = result.body;
    const status = analyzeDamaiStatus(html);
    log(`大麦状态：${status.text}`);

    if (status.sellable) {
      log('🎉 大麦检测到可售票！', 'FOUND');
      await sendWechatNotification(
        '🎫【大麦开售】周杰伦北京演唱会6月28日',
        `**场次：** ${CONFIG.targetDate} 19:00\n**平台：** 大麦网\n**状态：** ${status.text}\n\n⚡ **立即打开大麦App抢票！**\n\n> 脚本检测到页面出现可购票标识，请立刻行动！`
      );
      return true;
    }

    return false;
  } catch (err) {
    log(`大麦检测出错：${err.message}`, 'ERROR');
    return false;
  }
}

function analyzeDamaiStatus(html) {
  const patterns = {
    soldOut: /已售罄|售罄|卖完了|已结束|已下架/i,
    notStarted: /即将开售|即将开始|预售.*时间|开售.*时间|倒计时|waiting|notStart/i,
    onSale: /立即购买|选座购买|立即预定|马上抢|去购买|btn-buy|buy-btn|buyNow|submit/i,
    appOnly: /请到大麦App|请下载大麦|打开App|app购买|applogo/i,
    hasPrice: /¥\d{3,4}|\d{3,4}元|票价.*\d+/i,
    selling: /正在售票|热卖中|火爆抢购/i,
  };

  let text = '';
  let sellable = false;

  if (patterns.selling.test(html)) {
    text = '🔥 正在热卖中！';
    sellable = true;
  } else if (patterns.onSale.test(html) && !patterns.appOnly.test(html)) {
    text = '🎉 可购买！立即行动！';
    sellable = true;
  } else if (patterns.onSale.test(html)) {
    text = '⏳ 检测到购买按钮（App端，请打开App确认）';
    sellable = true;
  } else if (patterns.soldOut.test(html)) {
    text = '已售罄';
  } else if (patterns.notStarted.test(html)) {
    text = '⏳ 即将开售（倒计时中）';
  } else if (patterns.hasPrice.test(html)) {
    text = '⚠️ 有票价信息（可能可购，建议App确认）';
    sellable = true;
  } else {
    text = '状态未知（建议手动检查）';
  }

  return { text, sellable };
}

// ==================== 猫眼检测 ====================

async function checkMaoyan() {
  log('🐱 检查猫眼...');
  
  try {
    const result = await httpGet(CONFIG.maoyan.showUrl, {
      'Referer': 'https://m.maoyan.com/',
    });

    const html = result.body;
    const status = analyzeMaoyanStatus(html);
    log(`猫眼状态：${status.text}`);

    if (status.sellable) {
      log('🎉 猫眼检测到可售票！', 'FOUND');
      await sendWechatNotification(
        '🐱【猫眼开售】周杰伦北京演唱会6月28日',
        `**场次：** ${CONFIG.targetDate} 19:00\n**平台：** 猫眼\n**状态：** ${status.text}\n\n⚡ **立即打开猫眼App抢票！**\n\n> 脚本检测到猫眼平台可购票，请立刻行动！`
      );
      return true;
    }

    return false;
  } catch (err) {
    log(`猫眼检测出错：${err.message}`, 'ERROR');
    return false;
  }
}

function analyzeMaoyanStatus(html) {
  const patterns = {
    soldOut: /已售罄|售罄|卖完了|已结束/i,
    notStarted: /即将开售|即将开始|预售.*时间/i,
    onSale: /立即购买|选座购买|立即预定|马上抢|去购票|buyBtn|buy-now/i,
    hasPrice: /¥\d{3,4}|\d{3,4}元|票价.*\d+/i,
    selling: /正在售票|热卖中|火爆/i,
  };

  let text = '';
  let sellable = false;

  if (patterns.selling.test(html)) {
    text = '🔥 正在热卖中！';
    sellable = true;
  } else if (patterns.onSale.test(html)) {
    text = '🎉 可购买！立即行动！';
    sellable = true;
  } else if (patterns.soldOut.test(html)) {
    text = '已售罄';
  } else if (patterns.notStarted.test(html)) {
    text = '即将开售';
  } else if (patterns.hasPrice.test(html)) {
    text = '⚠️ 有票价信息（可能可购）';
    sellable = true;
  } else {
    text = '状态未知';
  }

  return { text, sellable };
}

// ==================== 主流程 ====================

async function main() {
  console.log('\n' + '='.repeat(50));
  console.log('🎫 周杰伦北京演唱会 - 云端监控');
  console.log('='.repeat(50));
  console.log(`📅 目标场次：${CONFIG.targetDate}`);
  console.log(`🎤 演出：${CONFIG.targetShow}`);
  console.log(`📱 通知方式：微信（Server酱）`);
  console.log(`☁️ 运行环境：${process.env.GITHUB_ACTIONS ? 'GitHub Actions' : '本地测试'}`);
  console.log(`⏰ 当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  console.log('='.repeat(50) + '\n');

  if (!CONFIG.serverChanKey || CONFIG.serverChanKey === 'YOUR_SEND_KEY_HERE') {
    log('⚠️ 未配置 SERVER_CHAN_KEY', 'WARN');
    log('请前往 https://sct.ftqq.com/ 获取 SendKey', 'WARN');
    process.exit(1);
  }

  // 同时检查两个平台
  const [damaiResult, maoyanResult] = await Promise.allSettled([
    checkDamai(),
    checkMaoyan(),
  ]);

  const damaiHit = damaiResult.status === 'fulfilled' && damaiResult.value;
  const maoyanHit = maoyanResult.status === 'fulfilled' && maoyanResult.value;

  console.log('\n' + '-'.repeat(50));
  log(`本轮检测完成 | 大麦：${damaiHit ? '🔔有票' : '无变化'} | 猫眼：${maoyanHit ? '🔔有票' : '无变化'}`);

  process.exit(0);
}

main().catch(err => {
  log(`脚本异常：${err.message}`, 'ERROR');
  console.error(err);
  process.exit(1);
});
