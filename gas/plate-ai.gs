/**
 * 車牌 AI 辨識轉送服務（Google Apps Script → Gemini API）
 *
 * 這是「獨立」的 Apps Script 專案，不要貼進原本存車輛資料的那個專案。
 *
 * 設定步驟：
 * 1. 到 https://aistudio.google.com/apikey 建立 Gemini API 金鑰。
 *    （若要避免照片被拿去改進模型，請在該專案開啟計費，改用付費方案）
 * 2. 到 https://script.google.com 新增專案，把這整份程式碼貼上、儲存。
 * 3. 左側「專案設定」→「指令碼屬性」→ 新增屬性：
 *      名稱：GEMINI_API_KEY    值：剛剛的金鑰
 * 4. 右上「部署」→「新增部署作業」→ 類型選「網頁應用程式」：
 *      執行身分：我
 *      誰可以存取：所有人
 *    部署後複製「網頁應用程式網址」（.../exec 結尾）。
 * 5. 把網址填到 index.html 的 PLATE_AI_URL。
 *
 * 之後修改程式碼要生效：部署 → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署。
 */

// 依序嘗試的模型：第一個失敗（不存在、額度用完）時自動改用下一個
const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite'];

// 每日辨識上限，避免網址外流被濫用、耗盡額度
const DAILY_LIMIT = 500;

const PROMPT = [
  '這是一張台灣車輛或車牌的照片。',
  '請讀出畫面中清楚可見的車牌號碼，依台灣格式加上連字號，例如 ABC-1234、AB-1234、1234-AB。',
  '台灣車牌不使用英文字母 I 與 O。',
  '看不清楚的車牌不要猜，直接略過；完全沒有車牌就回傳空陣列。',
  '只回傳 JSON：{"plates": ["..."]}'
].join('\n');

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const image = body.image;
    if (!image || typeof image !== 'string') return json_({ error: '缺少圖片' });
    if (image.length > 5000000) return json_({ error: '圖片太大' });
    if (!takeQuota_()) return json_({ error: '今日辨識次數已達上限' });

    const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!key) return json_({ error: '尚未設定 GEMINI_API_KEY' });

    const payload = {
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/jpeg', data: image } },
          { text: PROMPT }
        ]
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: { plates: { type: 'ARRAY', items: { type: 'STRING' } } },
          required: ['plates']
        }
      }
    };

    let lastError = '';
    for (const model of MODELS) {
      const res = UrlFetchApp.fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
        {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-goog-api-key': key },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        }
      );
      const code = res.getResponseCode();
      if (code === 200) {
        const data = JSON.parse(res.getContentText());
        const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
        const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
        let plates = [];
        try { plates = JSON.parse(text).plates || []; } catch (err) { plates = []; }
        plates = plates
          .map(p => String(p).toUpperCase().replace(/[^A-Z0-9-]/g, ''))
          .filter(p => p.replace(/-/g, '').length >= 4);
        return json_({ plates: plates, model: model });
      }
      lastError = model + ' 回應 ' + code;
      console.warn(lastError, res.getContentText().slice(0, 300));
      // 只有模型不存在、額度用完或伺服器錯誤時才換下一個模型
      if (code !== 404 && code !== 429 && code < 500) break;
    }
    return json_({ error: 'AI 辨識失敗（' + lastError + '）' });
  } catch (err) {
    console.error(err);
    return json_({ error: '伺服器錯誤：' + err });
  }
}

function doGet() {
  return json_({ ok: true, service: 'plate-ai' });
}

function takeQuota_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
    const saved = JSON.parse(props.getProperty('QUOTA') || '{}');
    const used = saved.date === today ? saved.count : 0;
    if (used >= DAILY_LIMIT) return false;
    props.setProperty('QUOTA', JSON.stringify({ date: today, count: used + 1 }));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 在編輯器中手動執行，確認金鑰與模型可用（看「執行紀錄」） */
function testConnection() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('尚未設定 GEMINI_API_KEY');
  MODELS.forEach(model => {
    const res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model,
      { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true }
    );
    console.log(model + ': ' + res.getResponseCode());
  });
}
