// ============ НАСТРОЙКИ ============
// Токен бота из @BotFather:
const TOKEN = 'ВСТАВЬ_СЮДА_ТОКЕН';

// Как называется лист в таблице (создастся сам, если его нет):
const ЛИСТ = 'СОН И ДЕНЬ';

// Секретное слово. Без него по ссылке /exec нельзя ни прочитать, ни записать.
// Менять не обязательно; если поменяешь — заново подключи таблицу в трекере.
const СЕКРЕТ = '74gqqa56nssr1fhz6gu4';
// ===================================


// ЗАПУСТИ ОДИН РАЗ вручную: включает бота.
// Убирает старую связку и заводит проверку новых сообщений раз в минуту.
function setup() {
  UrlFetchApp.fetch('https://api.telegram.org/bot' + TOKEN + '/deleteWebhook?drop_pending_updates=true');
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('poll').timeBased().everyMinutes(1).create();
  лист();
  Logger.log('Готово: бот проверяет сообщения раз в минуту');
}


// Запускается сам каждую минуту: забирает новые сообщения из Телеграма
function poll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const offset = Number(props.getProperty('OFFSET') || 0);
    const resp = UrlFetchApp.fetch(
      'https://api.telegram.org/bot' + TOKEN + '/getUpdates?timeout=0&offset=' + offset
    );
    const updates = JSON.parse(resp.getContentText()).result || [];
    if (!updates.length) return;

    for (let i = 0; i < updates.length; i++) {
      try {
        обработать(updates[i]);
      } catch (e) {
        Logger.log('Ошибка на обновлении ' + updates[i].update_id + ': ' + e.message);
        const m = updates[i].message;
        if (m && m.chat) {
          отправить(m.chat.id, 'Не смог обработать: ' + e.message);
        }
      }
    }
    props.setProperty('OFFSET', String(updates[updates.length - 1].update_id + 1));
  } finally {
    lock.releaseLock();
  }
}


function обработать(update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;
  const chat = msg.chat.id;

  // Голосовое: расшифровку Телеграм ботам не отдаёт даже на Premium.
  // Подсказываем рабочий способ — диктовку с клавиатуры.
  if (msg.voice || msg.video_note || msg.audio) {
    отправить(chat,
      'Голосовые я расшифровать не могу — Телеграм не отдаёт расшифровку ботам.\n\n' +
      'Но диктовать можно: нажми микрофон на клавиатуре (справа от пробела), ' +
      'скажи «сон 8 день 7» — телефон сам напишет текстом, и отправь.');
    return;
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  const low = text.toLowerCase();

  if (low === '/start' || low === '/help' || low === 'помощь') {
    отправить(chat, справка());
    return;
  }
  if (low === '/итог' || low === '/itog' || low === 'итог') {
    отправить(chat, итогМесяца());
    return;
  }
  if (low === '/сегодня' || low === '/today' || low === 'сегодня') {
    const d = new Date();
    отправить(chat, деньСтрокой(d));
    return;
  }

  // Удаление: «удали 1 сентября», «удали сон вчера», «убери день 3 сентября»
  if (/^(удали|удалить|убери|убрать|сотри|стереть|очисти)/.test(low)) {
    отправить(chat, удалитьПоТексту(low));
    return;
  }

  // Заметка: «заметка: не спал из-за Макара», «коммент вчера: тяжёлая отгрузка»
  if (/^(заметка|заметку|коммент\w*|комментарий|причина|почему)/i.test(low)) {
    отправить(chat, заметкаПоТексту(text));
    return;
  }

  const r = разобрать(text);
  if (!r) {
    отправить(chat,
      'Не разобрал. Напиши так: «сон 8 день 7».\n' +
      'Можно и одно из двух: «сон 8». Можно за прошлый день: «вчера сон 6 день 5».');
    return;
  }

  записать(r.дата, r.сон, r.день);
  let ответ = подтверждение(r);

  // Если слово было, а число не влезло в шкалу — честно сказать, что не записано
  const низ = low.replace(/ё/g, 'е');
  if (r.сон === null && /(сон|спал|выспал)/.test(низ)) {
    ответ += '\nСон не записал: шкала от 1 до 10.';
  }
  if (r.день === null && /(день|дня|днем|продуктивност)/.test(низ)) {
    ответ += '\nДень не записал: шкала от 1 до 10.';
  }
  отправить(chat, ответ);
}


// ──────────────── РАЗБОР СООБЩЕНИЯ ────────────────

const СЛОВА_ЧИСЕЛ = {
  'ноль': 0, 'один': 1, 'одна': 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4,
  'пять': 5, 'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9, 'десять': 10
};

const МЕСЯЦЫ_РОД = {
  'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4, 'мая': 5, 'июня': 6,
  'июля': 7, 'августа': 8, 'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12
};


// В JavaScript \b и \w не понимают кириллицу, поэтому границы слова задаём вручную.
const НЕ_БУКВА = '[^а-я0-9]';

function разобрать(text) {
  let s = ' ' + text.toLowerCase().replace(/ё/g, 'е') + ' ';

  // числительные словами → цифры («сон восемь» → «сон 8»)
  for (const слово in СЛОВА_ЧИСЕЛ) {
    const re = new RegExp('(' + НЕ_БУКВА + ')' + слово + '(?=' + НЕ_БУКВА + ')', 'g');
    s = s.replace(re, '$1' + String(СЛОВА_ЧИСЕЛ[слово]));
  }

  const дата = вытащитьДату(s);
  s = дата.остаток;

  let сон = null, день = null;

  // «сон 8» / «сон — 8» / «сон: 8» / «спал 8» / «выспался 8»
  const mСон = s.match(/(?:сон|спал|выспал)[а-я]*[^0-9]{0,4}(\d{1,2})/);
  if (mСон) сон = Number(mСон[1]);

  // «день 7» / «днём 7» / «продуктивность 7»
  const mДень = s.match(/(?:день|дня|днем|продуктивност)[а-я]*[^0-9]{0,4}(\d{1,2})/);
  if (mДень) день = Number(mДень[1]);

  // Ни одного слова-метки — берём просто два числа подряд: первое сон, второе день
  if (сон === null && день === null) {
    const числа = s.match(/(?:^|[^0-9])(10|[1-9])(?![0-9])/g);
    if (числа && числа.length >= 2) {
      сон = Number(числа[0].replace(/[^0-9]/g, ''));
      день = Number(числа[1].replace(/[^0-9]/g, ''));
    } else {
      return null; // одно число без метки — непонятно, к чему оно
    }
  }

  сон = проверить(сон);
  день = проверить(день);
  if (сон === null && день === null) return null;

  return { дата: дата.дата, сон: сон, день: день };
}


// «удали сон 1 сентября» / «удали 1 сентября» / «удали день вчера» / «удали сегодня»
function удалитьПоТексту(low) {
  let s = ' ' + low.replace(/ё/g, 'е') + ' ';
  s = s.replace(/^\s*(удалить|удали|убрать|убери|стереть|сотри|очисти)/, ' ');

  // Сначала вырезаем дату, иначе «сегодня» прочитается как «дня»
  const d = вытащитьДату(s);
  const дата = d.дата;
  const остаток = d.остаток;

  const хочетСон = /(сон|ночь|спал)/.test(остаток);
  const хочетДень = /(день|дня|днем|продуктивност)/.test(остаток);

  // Если ни сон, ни день не названы — удаляем весь день целиком
  if (!хочетСон && !хочетДень) {
    if (!естьЗапись(дата)) return 'За ' + датаСловами(дата) + ' и так ничего не записано.';
    очистить(дата);
    return 'Стёр весь день: ' + датаСловами(дата) + '.';
  }

  if (!естьЗапись(дата)) return 'За ' + датаСловами(дата) + ' и так ничего не записано.';

  стеретьПоле(дата, хочетСон, хочетДень);

  const что = [];
  if (хочетСон) что.push('сон');
  if (хочетДень) что.push('день');
  return 'Стёр ' + что.join(' и ') + ' за ' + датаСловами(дата) + '.';
}


// «заметка: не спал из-за Макара» / «коммент вчера: тяжёлая отгрузка»
// / «заметка 3 сентября: перебрал с кофе»
function заметкаПоТексту(text) {
  // Отрезаем слово-команду, сохраняя исходный регистр остального текста
  let s = text.replace(/^\s*(заметку|заметка|комментарий|коммент\w*|причина|почему)\s*/i, '');

  // Дату ищем в служебной копии, чтобы не портить текст самой заметки
  const служебная = ' ' + s.toLowerCase().replace(/ё/g, 'е') + ' ';
  const d = вытащитьДату(служебная);
  const дата = d.дата;

  // Убираем из текста то, что было распознано как дата
  s = s.replace(/^\s*(позавчера|вчера|сегодня)\s*/i, '');
  s = s.replace(/^\s*\d{1,2}\s+[а-яё]+\s*/i, '');
  s = s.replace(/^\s*\d{1,2}[.\/]\d{1,2}\s*/, '');
  s = s.replace(/^\s*[:—–-]\s*/, '').trim();

  if (!s) {
    const было = заметкаЗа(дата);
    if (!было) return 'Пустая заметка. Напиши так: «заметка вчера: не спал из-за Макара».';
    return 'Заметка за ' + датаСловами(дата) + ':\n' + было;
  }

  записать(дата, null, null, s);
  return 'Записал заметку за ' + датаСловами(дата) + ':\n' + s;
}


function заметкаЗа(дата) {
  const key = ключДаты(дата);
  const все = всеЗаписи();
  for (let i = 0; i < все.length; i++) {
    if (все[i].дата === key) return все[i].заметка;
  }
  return '';
}


function естьЗапись(дата) {
  const key = ключДаты(дата);
  const все = всеЗаписи();
  for (let i = 0; i < все.length; i++) {
    if (все[i].дата === key) return true;
  }
  return false;
}


function стеретьПоле(дата, сон, день) {
  const sh = лист();
  const key = ключДаты(дата);
  const last = sh.getLastRow();
  if (last < 2) return;
  const даты = sh.getRange(2, 1, last - 1, 1).getValues();

  for (let i = 0; i < даты.length; i++) {
    const v = даты[i][0];
    const k = (v instanceof Date) ? ключДаты(v) : String(v).trim();
    if (k !== key) continue;

    const строка = i + 2;
    if (сон) sh.getRange(строка, 2).clearContent();
    if (день) sh.getRange(строка, 3).clearContent();

    // Если после удаления оценок не осталось — убираем строку вместе с заметкой
    const остались = sh.getRange(строка, 2, 1, 2).getValues()[0];
    if (!остались[0] && !остались[1]) {
      sh.deleteRow(строка);
    } else {
      sh.getRange(строка, 4).setValue(
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM HH:mm')
      );
    }
    return;
  }
}


function проверить(v) {
  if (v === null || v === undefined) return null;
  if (!(v >= 1 && v <= 10)) return null;
  return v;
}


function вытащитьДату(s) {
  const сейчас = new Date();
  let d = new Date(сейчас.getFullYear(), сейчас.getMonth(), сейчас.getDate());

  if (/позавчера/.test(s)) {
    d.setDate(d.getDate() - 2);
    return { дата: d, остаток: s.replace(/позавчера/, ' ') };
  }
  if (/вчера/.test(s)) {
    d.setDate(d.getDate() - 1);
    return { дата: d, остаток: s.replace(/вчера/, ' ') };
  }
  if (/сегодня/.test(s)) {
    return { дата: d, остаток: s.replace(/сегодня/, ' ') };
  }

  // «3 сентября»
  const mСлово = s.match(/(\d{1,2})\s+(январ[а-я]*|феврал[а-я]*|март[а-я]*|апрел[а-я]*|ма[йя][а-я]*|июн[а-я]*|июл[а-я]*|август[а-я]*|сентябр[а-я]*|октябр[а-я]*|ноябр[а-я]*|декабр[а-я]*)/);
  if (mСлово) {
    const мес = месяцПоСлову(mСлово[2]);
    if (мес) {
      const нов = new Date(сейчас.getFullYear(), мес - 1, Number(mСлово[1]));
      return { дата: нов, остаток: s.replace(mСлово[0], ' ') };
    }
  }

  // «03.09» или «3.9»
  const mТочка = s.match(/(?:^|[^0-9])(\d{1,2})[.\/](\d{1,2})(?![0-9])/);
  if (mТочка) {
    const нов = new Date(сейчас.getFullYear(), Number(mТочка[2]) - 1, Number(mТочка[1]));
    return { дата: нов, остаток: s.replace(mТочка[0], ' ') };
  }

  return { дата: d, остаток: s };
}


function месяцПоСлову(w) {
  for (const k in МЕСЯЦЫ_РОД) {
    if (w.indexOf(k.slice(0, 4)) === 0) return МЕСЯЦЫ_РОД[k];
  }
  const короткие = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  for (let i = 0; i < короткие.length; i++) {
    if (w.indexOf(короткие[i]) === 0) return i + 1;
  }
  return 0;
}


// ──────────────── ТАБЛИЦА ────────────────

function лист() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ЛИСТ);
  if (!sh) {
    sh = ss.insertSheet(ЛИСТ);
    sh.getRange(1, 1, 1, 5).setValues([['Дата', 'Сон', 'День', 'Обновлено', 'Заметка']]);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 110);
    sh.setColumnWidth(4, 130);
    sh.setColumnWidth(5, 420);
    sh.getRange('E:E').setWrap(true);
  }
  // Лист мог остаться от прежней версии, без колонки заметок
  if (sh.getLastColumn() < 5 || sh.getRange(1, 5).getValue() !== 'Заметка') {
    sh.getRange(1, 5).setValue('Заметка').setFontWeight('bold');
    sh.setColumnWidth(5, 420);
    sh.getRange('E:E').setWrap(true);
  }
  return sh;
}


function ключДаты(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}


function найтиСтроку(sh, key) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const даты = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < даты.length; i++) {
    const v = даты[i][0];
    const k = (v instanceof Date) ? ключДаты(v) : String(v).trim();
    if (k === key) return i + 2;
  }
  return 0;
}


function записать(дата, сон, день, заметка) {
  const sh = лист();
  const key = ключДаты(дата);
  let строка = найтиСтроку(sh, key);

  if (!строка) {
    строка = sh.getLastRow() + 1;
    sh.getRange(строка, 1).setValue(key);
  }
  if (сон !== null && сон !== undefined) sh.getRange(строка, 2).setValue(сон);
  if (день !== null && день !== undefined) sh.getRange(строка, 3).setValue(день);
  if (заметка !== null && заметка !== undefined) sh.getRange(строка, 5).setValue(заметка);
  sh.getRange(строка, 4).setValue(
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM HH:mm')
  );
}


function всеЗаписи() {
  const sh = лист();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, 5).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i][0];
    if (!v) continue;
    out.push({
      дата: (v instanceof Date) ? ключДаты(v) : String(v).trim(),
      сон: Number(values[i][1]) || null,
      день: Number(values[i][2]) || null,
      заметка: String(values[i][4] || '').trim()
    });
  }
  return out;
}


// ──────────────── ОТВЕТЫ ────────────────

function подтверждение(r) {
  const части = [];
  if (r.сон !== null) части.push('сон ' + r.сон);
  if (r.день !== null) части.push('день ' + r.день);
  return 'Записал: ' + датаСловами(r.дата) + ' — ' + части.join(', ') + '.';
}


function деньСтрокой(d) {
  const key = ключДаты(d);
  const все = всеЗаписи();
  for (let i = 0; i < все.length; i++) {
    if (все[i].дата === key) {
      const с = все[i].сон === null ? 'не записан' : все[i].сон;
      const п = все[i].день === null ? 'не записан' : все[i].день;
      let out = датаСловами(d) + ': сон — ' + с + ', день — ' + п + '.';
      if (все[i].заметка) out += '\nЗаметка: ' + все[i].заметка;
      return out;
    }
  }
  return датаСловами(d) + ': пока ничего не записано.';
}


function итогМесяца() {
  const сейчас = new Date();
  const префикс = Utilities.formatDate(сейчас, Session.getScriptTimeZone(), 'yyyy-MM');
  const все = всеЗаписи().filter(function (e) { return e.дата.indexOf(префикс) === 0; });

  if (!все.length) return 'В этом месяце записей пока нет.';

  const сон = [], день = [], хорошо = [], плохо = [];
  все.forEach(function (e) {
    if (e.сон) сон.push(e.сон);
    if (e.день) день.push(e.день);
    if (e.сон && e.день) {
      if (e.сон >= 7) хорошо.push(e.день);
      else if (e.сон <= 5) плохо.push(e.день);
    }
  });

  let out = 'Итог месяца, записей: ' + все.length + '\n';
  out += 'Средний сон: ' + среднее(сон) + '\n';
  out += 'Средний день: ' + среднее(день) + '\n';

  if (хорошо.length >= 3 && плохо.length >= 3) {
    const g = Number(среднее(хорошо).replace(',', '.'));
    const b = Number(среднее(плохо).replace(',', '.'));
    const разница = Math.round((g - b) * 10) / 10;
    out += '\nВыспался (7–10): день ' + среднее(хорошо) +
           '\nНе выспался (1–5): день ' + среднее(плохо) +
           '\nРазница: ' + String(разница).replace('.', ',');
  } else {
    out += '\nДля связи сна и дня нужно хотя бы по три дня в каждой группе. ' +
           'Сейчас: выспался — ' + хорошо.length + ', не выспался — ' + плохо.length + '.';
  }
  return out;
}


function среднее(a) {
  if (!a.length) return '—';
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return String(Math.round(s / a.length * 10) / 10).replace('.', ',');
}


function датаСловами(d) {
  const мес = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
               'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  return d.getDate() + ' ' + мес[d.getMonth()];
}


function справка() {
  return 'Трекер сна и дня.\n\n' +
    'Пиши так:\n' +
    '• сон 8 день 7\n' +
    '• сон 8   (только сон)\n' +
    '• вчера сон 6 день 5\n' +
    '• 3 сентября сон 9 день 8\n' +
    '• 8 7   (первое — сон, второе — день)\n\n' +
    'Исправить — просто напиши заново, старое значение заменится.\n\n' +
    'Заметка — почему день был такой:\n' +
    '• заметка: не спал из-за Макара\n' +
    '• заметка вчера: тяжёлая отгрузка\n' +
    '• заметка 3 сентября: перебрал с кофе\n' +
    '(«заметка вчера» без текста — покажет, что записано)\n\n' +
    'Удалить:\n' +
    '• удали 1 сентября   (весь день)\n' +
    '• удали сон вчера    (только сон)\n' +
    '• удали день сегодня (только день)\n\n' +
    'Диктовать можно микрофоном на клавиатуре — телефон напишет текстом сам.\n\n' +
    'Команды:\n' +
    '/итог — средние за месяц и связь сна с днём\n' +
    '/сегодня — что записано за сегодня';
}


function отправить(chat, text) {
  UrlFetchApp.fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
    method: 'post',
    payload: { chat_id: String(chat), text: text },
    muteHttpExceptions: true
  });
}


// ──────────────── ДАННЫЕ ДЛЯ СТРАНИЦЫ-ТРЕКЕРА ────────────────
// После развёртывания как веб-приложения этот адрес отдаёт JSON,
// который читает страница sleep-tracker.html
function doGet(e) {
  if (!пропуск(e, null)) return json({ ok: false, error: 'нет доступа' });
  return json({ ok: true, data: собратьДляСтраницы() });
}


// Сюда страница присылает то, что ты натыкал руками на компьютере,
// чтобы таблица и страница не разъезжались.
function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!пропуск(e, body)) return json({ ok: false, error: 'нет доступа' });
    const дата = String(body.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(дата)) {
      return json({ ok: false, error: 'нужна дата в виде 2026-09-03' });
    }

    const части = дата.split('-');
    const d = new Date(Number(части[0]), Number(части[1]) - 1, Number(части[2]));

    const сон = чистое(body.sleep);
    const день = чистое(body.day);
    const заметка = (typeof body.note === 'string') ? body.note.slice(0, 1000) : null;

    if (body.clear === true) {
      очистить(d);
    } else {
      if (сон === null && день === null && заметка === null) {
        return json({ ok: false, error: 'нет ни оценок, ни заметки' });
      }
      записать(d, сон, день, заметка);
    }
    return json({ ok: true, data: собратьДляСтраницы() });
  } catch (err) {
    return json({ ok: false, error: err.message });
  }
}


// Секрет ищем и в адресе (?k=…), и в теле запроса — при переадресации
// у Google параметры адреса иногда теряются.
function пропуск(e, body) {
  if (!СЕКРЕТ) return true;
  const изАдреса = (e && e.parameter && e.parameter.k) || '';
  const изТела = (body && body.k) || '';
  return изАдреса === СЕКРЕТ || изТела === СЕКРЕТ;
}


function чистое(v) {
  const n = Number(v);
  if (!(n >= 1 && n <= 10)) return null;
  return Math.round(n);
}


function собратьДляСтраницы() {
  const данные = {};
  всеЗаписи().forEach(function (e) {
    данные[e.дата] = { sleep: e.сон || 0, day: e.день || 0, note: e.заметка || '' };
  });
  return данные;
}


function очистить(дата) {
  const sh = лист();
  const key = ключДаты(дата);
  const last = sh.getLastRow();
  if (last < 2) return;
  const даты = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < даты.length; i++) {
    const v = даты[i][0];
    const k = (v instanceof Date) ? ключДаты(v) : String(v).trim();
    if (k === key) { sh.deleteRow(i + 2); return; }
  }
}


function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ──────────────── САМОПРОВЕРКА ────────────────
// Запусти вручную, чтобы убедиться, что разбор работает. Смотри Логи.
function тестРазбора() {
  const примеры = [
    'сон 8 день 7',
    'Сон 8, день 6',
    'сон восемь день семь',
    'сон 9',
    'день 4',
    'вчера сон 6 день 5',
    '3 сентября сон 9 день 8',
    '8 7',
    'сон — 10, день — 9',
    'спал 7 днем 6',
    'привет'
  ];
  примеры.forEach(function (p) {
    const r = разобрать(p);
    Logger.log('«' + p + '» → ' + (r ? (датаСловами(r.дата) + ' сон=' + r.сон + ' день=' + r.день) : 'не разобрано'));
  });
}
