/***** PROPERTIES *****/

function prop(name, fallback){
  const v = PropertiesService.getScriptProperties().getProperty(name);
  return (v === null || v === undefined) ? (fallback !== undefined ? fallback : '') : String(v);
}
function getApiSecret(){ return (prop('TG_API_SECRET', prop('TELEGRAM_WEBHOOK_SECRET','')) || '').trim(); }
function getBotToken(){ return (prop('TELEGRAM_BOT_TOKEN', prop('BOT_TOKEN','')) || '').trim(); }
function getAdminChatId(){ return prop('TELEGRAM_ADMIN_CHAT_ID','').trim(); }
function getSpreadsheetId(){ return prop('SPREADSHEET_ID','').trim(); }

function json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/***** TELEGRAM SEND *****/
function tgSendToChat(chatId, text, opts){
  try{
    const token=getBotToken(); if(!token) return {ok:false,error:'no_token'};
    const r=UrlFetchApp.fetch('https://api.telegram.org/bot'+token+'/sendMessage',{
      method:'post', contentType:'application/json', muteHttpExceptions:true,
      payload: JSON.stringify({ chat_id:String(chatId), text:String(text), disable_web_page_preview:true, ...(opts||{}) })
    });
    return { ok:r.getResponseCode()===200, http:r.getResponseCode(), body:r.getContentText() };
  }catch(ex){ return { ok:false, error:String(ex) }; }
}
function tgSendAdmin(text, opts){
  const chat=getAdminChatId(); if(!chat) return { ok:false, error:'no_admin_chat' };
  return tgSendToChat(chat, text, opts);
}

/***** Users: поиск chatId по телефону/email *****/
function ensureUsersSheet(){
  const ss = SpreadsheetApp.openById(getSpreadsheetId());
  let sh = ss.getSheetByName('Users') || ss.insertSheet('Users');
  const expected=['PhoneE164','ChatId','Username','FirstName','LastName','LinkedAt','LastSeen','Source','Email','StudentId'];
  const header = sh.getRange(1,1,1,expected.length).getValues()[0];
  const same = expected.every((v,i)=>String(header[i]||'')===v);
  if(!same) sh.getRange(1,1,1,expected.length).setValues([expected]);
  return sh;
}
function phoneDigits(s){ return String(s||'').replace(/\D/g,''); }
function usersGetChatIdByPhone(phone){
  const d=phoneDigits(phone||''); if(!d) return '';
  const sh=ensureUsersSheet(); const last=sh.getLastRow(); if(last<2) return '';
  const vals=sh.getRange(2,1,last-1,10).getValues();
  for (let i=0;i<vals.length;i++){
    if (phoneDigits(vals[i][0]||'')===d){
      const ch=String(vals[i][1]||'').trim(); if(ch) return ch;
    }
  }
  return '';
}
function usersGetChatIdByEmail(email){
  const e=String(email||'').trim().toLowerCase(); if(!e) return '';
  const sh=ensureUsersSheet(); const last=sh.getLastRow(); if(last<2) return '';
  const vals=sh.getRange(2,1,last-1,10).getValues();
  for (let i=0;i<vals.length;i++){
    const em=String(vals[i][8]||'').trim().toLowerCase(); const ch=String(vals[i][1]||'').trim();
    if (em && em===e && ch) return ch;
  }
  return '';
}

/***** HTTP *****/
function doPost(e){
  try{
    const raw=e.postData && e.postData.contents || '';
    let data={}; try{ data=JSON.parse(raw); }catch(_){}
    if(!data || !data.action) return json({ok:false,error:'no_action'});

    const token=String(data.token||'').trim();
    if(token!==getApiSecret()) return json({ok:false,error:'forbidden'});

    if (data.action==='notifyAdmin'){
      const text=String(data.text||'').trim();
      if(!text) return json({ok:false,error:'empty_text'});
      const r=tgSendAdmin(text,{ parse_mode:'HTML', disable_web_page_preview:true });
      return json({ ok:(r.ok===true || r.http===200), http:r.http||0, body:r.body||'', error:r.error||'' });
    }

    if (data.action==='notifyStudent'){
      const text=String(data.text||'').trim();
      if(!text) return json({ok:false,error:'empty_text'});

      // 1) прямой chatId (предпочтительно)
      let chatId=String(data.chatId||'').trim();

      // 2) опционально: поиск по телефону/email (если заполнена таблица Users)
      if(!chatId && data.phoneE164) chatId = usersGetChatIdByPhone(data.phoneE164);
      if(!chatId && data.phone)     chatId = usersGetChatIdByPhone(data.phone);
      if(!chatId && data.email)     chatId = usersGetChatIdByEmail(data.email);

      if(!chatId) return json({ok:false,error:'no_chat'});
      const r=tgSendToChat(chatId, text, { disable_web_page_preview:true });
      return json({ ok:(r.ok===true || r.http===200), chatId, http:r.http||0, body:r.body||'', error:r.error||'' });
    }

    if (data.action==='getMe'){
      const t=getBotToken(); if(!t) return json({ok:false,error:'no_token'});
      const r=UrlFetchApp.fetch('https://api.telegram.org/bot'+t+'/getMe',{method:'get',muteHttpExceptions:true});
      return json({ ok:r.getResponseCode()===200, http:r.getResponseCode(), body:r.getContentText() });
    }
    if (data.action==='testSend'){
      const ch = String(data.chatId||getAdminChatId()||'').trim();
      if(!ch) return json({ok:false,error:'no_chat'});
      const r=tgSendToChat(ch, 'ping '+new Date().toISOString());
      return json({ ok:(r.ok===true||r.http===200), chatId:ch, http:r.http||0, body:r.body||'', error:r.error||'', tokenLen:getBotToken().length });
    }

    return json({ok:false,error:'unknown_action'});
  }catch(ex){ return json({ok:false,error:String(ex)}); }
}
function doGet(e){
  const a=String(e.parameter.action||'').trim();
  if (a==='diag'){
    const t=getBotToken();
    return json({
      ok:true,
      hasToken: !!t, tokenLen: (t||'').length,
      adminChat: getAdminChatId(),
      secretOk: !!getApiSecret(),
      time: new Date().toISOString()
    });
  }
  return json({ ok:true, service:'notify-only', time:new Date().toISOString() });
}