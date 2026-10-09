'use strict';

(() => {
  // ---------------------------------------------------------------- constants

  const STORAGE_KEY = 'timeBudget.data';
  const BACKUP_KEY = 'timeBudget.corruptBackup';
  const SCHEMA_VERSION = 1;

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  // Timers stopped sooner than this are treated as accidental taps.
  const MIN_SESSION_MS = 10 * 1000;

  const PALETTE = ['#4F7CAC', '#5B9A8B', '#C08552', '#8E7CC3', '#C96A6A', '#6E8B3D', '#B0679A', '#7A8794'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // -------------------------------------------------------------------- state

  let state;
  let tab = 'today';
  let weekOffset = 0; // 0 = current week, -1 = previous, ...
  let sessionsShown = 30;
  let lastWeekMinute = -1;
  // startTs of the timer the user already chose to keep, so we ask once per launch.
  let keptTimerStartTs = null;
  let bootMessage = null;

  const $ = (sel) => document.querySelector(sel);
  const view = $('#view');

  // --------------------------------------------------------------- data model

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function seedData() {
    const seed = [['Analysis', 10], ['Bench', 15], ['Writing', 6], ['German', 4], ['Gym', 4]];
    return {
      schemaVersion: SCHEMA_VERSION,
      areas: seed.map(([name, hours], i) => ({
        id: uid(), name, color: PALETTE[i], weeklyBudgetMinutes: hours * 60, archived: false,
      })),
      sessions: [],
      activeTimer: null,
      settings: { weekStartsOn: 1, longSessionWarnHours: 4 },
    };
  }

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isTs = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

  // Checks structure and returns a clean copy. Used for both localStorage and import.
  function validateData(d) {
    const fail = (error) => ({ ok: false, error });
    if (!isObj(d)) return fail('This is not a Time Budget data file.');
    if (!Number.isInteger(d.schemaVersion)) return fail('The data has no schemaVersion.');
    if (d.schemaVersion > SCHEMA_VERSION) {
      return fail(`The data is from a newer version of the app (schema ${d.schemaVersion}, this app reads ${SCHEMA_VERSION}).`);
    }
    if (d.schemaVersion < 1) return fail(`Unknown schemaVersion ${d.schemaVersion}.`);
    // Migrations from older schema versions would go here.

    if (!Array.isArray(d.areas)) return fail('The "areas" list is missing.');
    if (!Array.isArray(d.sessions)) return fail('The "sessions" list is missing.');

    const areaIds = new Set();
    const areas = [];
    for (const [i, a] of d.areas.entries()) {
      const where = `Area ${i + 1}`;
      if (!isObj(a)) return fail(`${where} is not an object.`);
      if (typeof a.id !== 'string' || !a.id) return fail(`${where} has no id.`);
      if (areaIds.has(a.id)) return fail(`${where} repeats an id.`);
      if (typeof a.name !== 'string' || !a.name.trim()) return fail(`${where} has no name.`);
      if (!isHex(a.color)) return fail(`${where} has an invalid color.`);
      if (typeof a.weeklyBudgetMinutes !== 'number' || !Number.isFinite(a.weeklyBudgetMinutes) || a.weeklyBudgetMinutes < 0) {
        return fail(`${where} has an invalid budget.`);
      }
      areaIds.add(a.id);
      areas.push({
        id: a.id, name: a.name.trim(), color: a.color,
        weeklyBudgetMinutes: Math.round(a.weeklyBudgetMinutes), archived: a.archived === true,
      });
    }

    const sessionIds = new Set();
    const sessions = [];
    for (const [i, s] of d.sessions.entries()) {
      const where = `Session ${i + 1}`;
      if (!isObj(s)) return fail(`${where} is not an object.`);
      if (typeof s.id !== 'string' || !s.id) return fail(`${where} has no id.`);
      if (sessionIds.has(s.id)) return fail(`${where} repeats an id.`);
      if (!areaIds.has(s.areaId)) return fail(`${where} points to an area that does not exist.`);
      if (!isTs(s.startTs) || !isTs(s.endTs)) return fail(`${where} has invalid timestamps.`);
      if (s.endTs <= s.startTs) return fail(`${where} ends before it starts.`);
      sessionIds.add(s.id);
      sessions.push({
        id: s.id, areaId: s.areaId, startTs: s.startTs, endTs: s.endTs,
        note: typeof s.note === 'string' ? s.note : '',
      });
    }

    let activeTimer = null;
    if (d.activeTimer != null) {
      const t = d.activeTimer;
      if (!isObj(t) || !areaIds.has(t.areaId) || !isTs(t.startTs)) return fail('The active timer is invalid.');
      activeTimer = { areaId: t.areaId, startTs: t.startTs };
    }

    const st = isObj(d.settings) ? d.settings : {};
    const settings = {
      weekStartsOn: Number.isInteger(st.weekStartsOn) && st.weekStartsOn >= 0 && st.weekStartsOn <= 6 ? st.weekStartsOn : 1,
      longSessionWarnHours: typeof st.longSessionWarnHours === 'number' && st.longSessionWarnHours > 0 && st.longSessionWarnHours <= 168
        ? st.longSessionWarnHours : 4,
    };

    return { ok: true, data: { schemaVersion: SCHEMA_VERSION, areas, sessions, activeTimer, settings } };
  }

  function load() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      bootMessage = 'Storage is unavailable, so nothing will be saved in this browser.';
      return seedData();
    }
    if (raw === null) return seedData();

    let result;
    try {
      result = validateData(JSON.parse(raw));
    } catch (e) {
      result = { ok: false };
    }
    if (result.ok) return result.data;

    // Keep the unreadable string so nothing is lost, then start from seed data.
    try { localStorage.setItem(BACKUP_KEY, raw); } catch (e) { /* nothing more we can do */ }
    bootMessage = 'Saved data could not be read. Starting fresh; the old data is kept as a backup in Settings.';
    return seedData();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      toast('Could not save. Storage is full or unavailable.');
      return false;
    }
  }

  const areaById = (id) => state.areas.find((a) => a.id === id);
  const areaName = (id) => (areaById(id) || { name: 'Unknown' }).name;

  // ----------------------------------------------------------- time utilities

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  // Calendar arithmetic (not +24 h) so daylight-saving days keep their real length.
  function addDays(ts, n) {
    const d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  function weekStart(ts) {
    const d = new Date(startOfDay(ts));
    const back = (d.getDay() - state.settings.weekStartsOn + 7) % 7;
    d.setDate(d.getDate() - back);
    return d.getTime();
  }

  // Clock moved backwards? Never report negative elapsed time.
  const elapsedSince = (startTs, now) => Math.max(0, now - startTs);

  // Saved sessions plus the running timer, as plain intervals.
  function allIntervals(now) {
    const list = state.sessions.map((s) => ({ areaId: s.areaId, start: s.startTs, end: s.endTs }));
    const t = state.activeTimer;
    if (t) list.push({ areaId: t.areaId, start: t.startTs, end: t.startTs + elapsedSince(t.startTs, now) });
    return list;
  }

  // Per-area milliseconds inside [from, to). Each interval is clipped to the
  // window, which is what splits a session that crosses midnight or a week
  // boundary so each day and week gets only its own share.
  function totalsIn(from, to, now) {
    const totals = {};
    for (const iv of allIntervals(now)) {
      const overlap = Math.min(iv.end, to) - Math.max(iv.start, from);
      if (overlap > 0) totals[iv.areaId] = (totals[iv.areaId] || 0) + overlap;
    }
    return totals;
  }

  const sumValues = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);

  // --------------------------------------------------------------- formatting

  function fmtMin(totalMin) {
    const m = Math.max(0, Math.floor(totalMin));
    const h = Math.floor(m / 60);
    if (!h) return `${m}m`;
    return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  }
  const fmtDur = (ms) => fmtMin(ms / MIN);

  function fmtClock(ms) {
    const s = Math.floor(Math.max(0, ms) / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const fmtDayLong = (ts) => new Date(ts).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtShortDate = (ts) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });

  // <input type="datetime-local"> works in local time with minute precision.
  function toLocalInput(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const fromLocalInput = (str) => (str ? new Date(str).getTime() : NaN);

  // If the field still shows the original minute, keep the original timestamp
  // (with its seconds) so an untouched edit never shifts or overlaps anything.
  function readTs(input, originalTs) {
    if (originalTs != null && input.value === toLocalInput(originalTs)) return originalTs;
    return fromLocalInput(input.value);
  }

  const hoursText = (minutes) => String(Math.round((minutes / 60) * 100) / 100);

  // -------------------------------------------------------------- DOM helpers

  const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected']);

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // Replaces the view's content; like h(), it skips null and false children.
  function mount(...kids) {
    view.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  }

  let toastTimer;
  function toast(msg, ms = 2800) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  // ------------------------------------------------------------------- sheets

  let closeSheet = null;

  function openSheet(title, build, { dismissable = true } = {}) {
    if (closeSheet) closeSheet();
    const root = $('#sheet-root');
    let onClose = null;

    const close = () => {
      root.replaceChildren();
      document.body.classList.remove('sheet-open');
      document.removeEventListener('keydown', onKey);
      closeSheet = null;
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };

    const body = h('div', { class: 'sheet-body' });
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-head' },
        h('h2', null, title),
        dismissable && h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
      body);
    const backdrop = h('div', { class: 'backdrop' }, sheet);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop && dismissable) close(); });

    build(body, close, (fn) => { onClose = fn; });
    root.append(backdrop);
    document.body.classList.add('sheet-open');
    document.addEventListener('keydown', onKey);
    closeSheet = close;
  }

  function confirmSheet(title, message, okLabel, { danger = false } = {}) {
    return new Promise((resolve) => {
      let answer = false;
      openSheet(title, (body, close, onClose) => {
        onClose(() => resolve(answer));
        body.append(
          h('p', null, message),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: danger ? 'btn danger' : 'btn primary', onclick: () => { answer = true; close(); } }, okLabel),
            h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel')));
      });
    });
  }

  const field = (label, control) => h('label', { class: 'field' }, h('span', null, label), control);

  function errorBox() {
    const el = h('p', { class: 'error', role: 'alert', hidden: true });
    el.show = (msg) => { el.textContent = msg; el.hidden = false; el.scrollIntoView({ block: 'nearest' }); };
    return el;
  }

  // -------------------------------------------------------------------- timer

  function startTimer(areaId) {
    state.activeTimer = { areaId, startTs: Date.now() };
    keptTimerStartTs = null;
  }

  // Ends the running timer at endTs and stores it as a session.
  function stopTimer(endTs = Date.now()) {
    const t = state.activeTimer;
    if (!t) return;
    state.activeTimer = null;
    const duration = endTs - t.startTs; // negative if the clock went backwards
    if (duration >= MIN_SESSION_MS) {
      state.sessions.push({ id: uid(), areaId: t.areaId, startTs: t.startTs, endTs, note: '' });
      toast(`Saved ${duration < MIN ? 'under a minute' : fmtDur(duration)} of ${areaName(t.areaId)}`);
    } else {
      toast('Under 10 seconds, not saved');
    }
  }

  function toggleArea(areaId) {
    const t = state.activeTimer;
    if (t && t.areaId === areaId) {
      stopTimer();
    } else {
      // Only one timer at a time: starting another stops and saves the current one.
      if (t) stopTimer();
      startTimer(areaId);
    }
    save();
    render();
  }

  // Forgotten timer: ask what to do when it has run past the warning threshold.
  function checkForgottenTimer() {
    const t = state.activeTimer;
    if (!t || closeSheet) return;
    if (keptTimerStartTs === t.startTs) return;
    const elapsed = elapsedSince(t.startTs, Date.now());
    if (elapsed <= state.settings.longSessionWarnHours * HOUR) return;

    openSheet('Timer still running', (body, close) => {
      const err = errorBox();
      const endInput = h('input', {
        type: 'datetime-local', value: toLocalInput(Date.now()),
        min: toLocalInput(t.startTs), max: toLocalInput(Date.now()),
      });
      const customBox = h('div', { hidden: true },
        field('It actually ended at', endInput),
        h('div', { class: 'actions' },
          h('button', {
            type: 'button', class: 'btn primary',
            onclick: () => {
              const endTs = fromLocalInput(endInput.value);
              const problem = Number.isFinite(endTs) && endTs <= t.startTs
                ? `The end time must be after the start (${fmtDay(t.startTs)}, ${fmtTime(t.startTs)}).`
                : validateSession({ id: null, startTs: t.startTs, endTs }, { ignoreTimer: true });
              if (problem) return err.show(problem);
              stopTimer(endTs);
              save();
              close();
              render();
            },
          }, 'Save with this end time')));
      const choices = h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'btn primary',
          onclick: () => { stopTimer(); save(); close(); render(); },
        }, 'Stop it now'),
        h('button', {
          type: 'button', class: 'btn',
          onclick: () => { choices.hidden = true; customBox.hidden = false; },
        }, 'Set a custom end time'),
        h('button', {
          type: 'button', class: 'btn',
          onclick: () => { keptTimerStartTs = t.startTs; close(); },
        }, 'Keep it running'));

      body.append(
        h('p', null, `${areaName(t.areaId)} has been running for ${fmtDur(elapsed)}, since ${fmtDay(t.startTs)} at ${fmtTime(t.startTs)}. Did you forget to stop it?`),
        err, choices, customBox);
    }, { dismissable: false });
  }

  // ---------------------------------------------------------------- sessions

  // Returns a message describing why the session is not acceptable, or null.
  function validateSession(c, { ignoreTimer = false } = {}) {
    if (!Number.isFinite(c.startTs) || !Number.isFinite(c.endTs)) return 'Enter both a start and an end time.';
    if (c.endTs < c.startTs) return 'The end time is before the start time.';
    if (c.endTs === c.startTs) return 'Start and end are the same, so the session would have zero length.';
    if (c.endTs > Date.now()) return 'The end time is in the future.';

    const hit = state.sessions.find((s) => s.id !== c.id && c.startTs < s.endTs && s.startTs < c.endTs);
    if (hit) {
      return `This overlaps your ${areaName(hit.areaId)} session on ${fmtDay(hit.startTs)}, ${fmtTime(hit.startTs)} to ${fmtTime(hit.endTs)}.`;
    }
    const t = state.activeTimer;
    if (!ignoreTimer && t && c.endTs > t.startTs) {
      return `This overlaps the running ${areaName(t.areaId)} timer, which started at ${fmtTime(t.startTs)}. Stop the timer first.`;
    }
    return null;
  }

  function openSessionSheet(session) {
    const isNew = !session;
    const areas = state.areas.filter((a) => !a.archived || (session && session.areaId === a.id));
    if (!areas.length) return toast('Add an area first');

    const defaultEnd = Math.floor(Date.now() / MIN) * MIN;
    const orig = session || { startTs: null, endTs: null };

    openSheet(isNew ? 'Add session' : 'Edit session', (body, close) => {
      const err = errorBox();
      const areaSel = h('select', null, areas.map((a) => h('option', { value: a.id }, a.archived ? `${a.name} (archived)` : a.name)));
      if (session) areaSel.value = session.areaId;
      const startIn = h('input', { type: 'datetime-local', value: toLocalInput(session ? session.startTs : defaultEnd - HOUR) });
      const endIn = h('input', { type: 'datetime-local', value: toLocalInput(session ? session.endTs : defaultEnd) });
      const noteIn = h('input', { type: 'text', value: session ? session.note : '', maxlength: '200', placeholder: 'Optional', autocomplete: 'off' });

      const onSave = () => {
        const candidate = {
          id: session ? session.id : uid(),
          areaId: areaSel.value,
          startTs: readTs(startIn, orig.startTs),
          endTs: readTs(endIn, orig.endTs),
          note: noteIn.value.trim(),
        };
        const problem = validateSession(candidate);
        if (problem) return err.show(problem);
        if (session) Object.assign(session, candidate);
        else state.sessions.push(candidate);
        save();
        close();
        render();
        toast(isNew ? 'Session added' : 'Session updated');
      };

      const onDelete = async () => {
        const ok = await confirmSheet('Delete session?',
          `${areaName(session.areaId)}, ${fmtDay(session.startTs)}, ${fmtDur(session.endTs - session.startTs)}. This cannot be undone.`,
          'Delete', { danger: true });
        if (!ok) return;
        state.sessions = state.sessions.filter((s) => s.id !== session.id);
        save();
        render();
        toast('Session deleted');
      };

      body.append(
        field('Area', areaSel), field('Start', startIn), field('End', endIn), field('Note', noteIn), err,
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn primary', onclick: onSave }, 'Save'),
          !isNew && h('button', { type: 'button', class: 'btn danger', onclick: onDelete }, 'Delete session')));
    });
  }

  // -------------------------------------------------------------------- areas

  function setArchived(area, archived) {
    if (archived && state.activeTimer && state.activeTimer.areaId === area.id) stopTimer();
    area.archived = archived;
  }

  function openAreaSheet(area) {
    const isNew = !area;
    let color = area ? area.color : PALETTE[state.areas.length % PALETTE.length];

    openSheet(isNew ? 'New area' : 'Edit area', (body, close) => {
      const err = errorBox();
      const nameIn = h('input', { type: 'text', value: area ? area.name : '', maxlength: '40', placeholder: 'e.g. Reading', autocomplete: 'off' });
      const budgetIn = h('input', { type: 'text', inputmode: 'decimal', value: area ? hoursText(area.weeklyBudgetMinutes) : '5', autocomplete: 'off' });

      const customIn = h('input', { type: 'color', value: color, 'aria-label': 'Custom color' });
      const swatches = PALETTE.map((c) => h('button', {
        type: 'button', class: 'swatch', role: 'radio', style: `--c:${c}`, 'aria-label': `Color ${c}`,
        onclick: () => { color = c; customIn.value = c; paint(); },
      }));
      const paint = () => swatches.forEach((s, i) => s.setAttribute('aria-checked', String(PALETTE[i].toLowerCase() === color.toLowerCase())));
      customIn.addEventListener('input', () => { color = customIn.value; paint(); });
      paint();

      const onSave = () => {
        const name = nameIn.value.trim();
        const hours = Number(budgetIn.value.trim().replace(',', '.'));
        if (!name) return err.show('Give the area a name.');
        if (state.areas.some((a) => a !== area && a.name.toLowerCase() === name.toLowerCase())) {
          return err.show(`There is already an area called "${name}".`);
        }
        if (budgetIn.value.trim() === '' || !Number.isFinite(hours) || hours < 0) {
          return err.show('Enter the weekly budget in hours, for example 6 or 2.5. Use 0 for no budget.');
        }
        if (hours > 168) return err.show('A week only has 168 hours.');
        if (!isHex(color)) return err.show('Pick a color.');
        const values = { name, color, weeklyBudgetMinutes: Math.round(hours * 60) };
        if (area) Object.assign(area, values);
        else state.areas.push({ id: uid(), ...values, archived: false });
        save();
        close();
        render();
      };

      const onArchive = () => {
        setArchived(area, !area.archived);
        save();
        close();
        render();
        toast(area.archived ? `${area.name} archived` : `${area.name} restored`);
      };

      const onDelete = async () => {
        const hasHistory = state.sessions.some((s) => s.areaId === area.id)
          || (state.activeTimer && state.activeTimer.areaId === area.id);
        if (hasHistory) {
          // Never drop history: an area with sessions is archived, not deleted.
          setArchived(area, true);
          save();
          close();
          render();
          toast(`${area.name} has tracked time, so it was archived to keep its history`, 4200);
          return;
        }
        const ok = await confirmSheet('Delete area?', `"${area.name}" has no sessions and will be removed.`, 'Delete', { danger: true });
        if (!ok) return;
        state.areas = state.areas.filter((a) => a.id !== area.id);
        save();
        render();
      };

      body.append(
        field('Name', nameIn),
        field('Weekly budget (hours)', budgetIn),
        h('div', { class: 'field' }, h('span', null, 'Color'),
          h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Color' }, swatches, customIn)),
        err,
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'btn primary', onclick: onSave }, 'Save'),
          !isNew && h('button', { type: 'button', class: 'btn', onclick: onArchive }, area.archived ? 'Restore from archive' : 'Archive'),
          !isNew && h('button', { type: 'button', class: 'btn danger', onclick: onDelete }, 'Delete area')));
    });
  }

  // ------------------------------------------------------------ export/import

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function exportText(filename, text) {
    // On phones the share sheet ("Save to Files") is more dependable than a download link.
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.canShare) {
      try {
        const file = new File([text], filename, { type: 'application/json' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') return; // user closed the share sheet
      }
    }
    downloadText(filename, text);
  }

  function exportData() {
    const stamp = toLocalInput(Date.now()).slice(0, 10);
    const payload = { ...state, exportedAt: new Date().toISOString() };
    exportText(`time-budget-${stamp}.json`, JSON.stringify(payload, null, 2));
  }

  function exportCorruptBackup() {
    let raw = null;
    try { raw = localStorage.getItem(BACKUP_KEY); } catch (e) { /* ignore */ }
    if (raw !== null) exportText('time-budget-unreadable-backup.txt', raw);
  }

  async function importFile(file) {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (e) {
      return toast('Import failed: the file is not valid JSON.', 4200);
    }
    const result = validateData(parsed);
    if (!result.ok) return toast(`Import failed: ${result.error}`, 5200);

    const d = result.data;
    const ok = await confirmSheet('Replace all data?',
      `The file has ${d.areas.length} area${d.areas.length === 1 ? '' : 's'} and ${d.sessions.length} session${d.sessions.length === 1 ? '' : 's'}. `
      + `It will overwrite the ${state.areas.length} areas and ${state.sessions.length} sessions on this device. This cannot be undone.`,
      'Replace my data', { danger: true });
    if (!ok) return;
    state = d;
    keptTimerStartTs = null;
    save();
    render();
    toast('Data imported');
    checkForgottenTimer();
  }

  // -------------------------------------------------------------- view: Today

  function renderToday() {
    const areas = state.areas.filter((a) => !a.archived);
    const cards = areas.map((a) => h('button', {
      type: 'button', class: 'card', 'data-area': a.id, style: `--c:${a.color}`,
      onclick: () => toggleArea(a.id),
    },
      h('div', { class: 'card-top' },
        h('span', { class: 'card-name' }, a.name),
        h('span', { class: 'card-state' })),
      h('div', { class: 'card-timer num', hidden: true }),
      h('div', { class: 'card-nums' },
        h('span', { class: 'card-big num' }),
        h('span', { class: 'card-of num' })),
      h('div', { class: 'bar', style: `--c:${a.color}` }, h('div', { class: 'bar-fill' })),
      h('div', { class: 'card-foot num' })));

    mount(
      h('header', { class: 'head' }, h('h1', null, 'Today'), h('p', { id: 'today-sub', class: 'num' })),
      areas.length
        ? h('div', { class: 'cards' }, cards)
        : h('p', { class: 'empty' }, 'No areas yet. Add one in Settings.'));
    fillToday();
  }

  // Updates numbers in place (no DOM rebuild), so it is safe to call every second.
  function fillToday() {
    const now = Date.now();
    const ws = weekStart(now);
    const week = totalsIn(ws, addDays(ws, 7), now);
    const ds = startOfDay(now);
    const today = totalsIn(ds, addDays(ds, 1), now);
    const t = state.activeTimer;

    const sub = $('#today-sub');
    if (sub) sub.textContent = `${fmtDayLong(now)} · ${fmtDur(sumValues(today))} today`;

    for (const card of view.querySelectorAll('.card')) {
      const a = areaById(card.dataset.area);
      if (!a) continue;
      const tracked = week[a.id] || 0;
      const trackedMin = Math.floor(tracked / MIN);
      const budgetMin = a.weeklyBudgetMinutes;
      const running = !!t && t.areaId === a.id;
      const q = (cls) => card.querySelector(cls);

      card.classList.toggle('running', running);
      card.setAttribute('aria-pressed', String(running));
      q('.card-state').textContent = running ? 'Running · tap to stop' : 'Tap to start';
      q('.card-timer').hidden = !running;
      if (running) q('.card-timer').textContent = fmtClock(elapsedSince(t.startTs, now));
      q('.card-big').textContent = fmtMin(trackedMin);

      const todayText = `${fmtDur(today[a.id] || 0)} today`;
      if (budgetMin > 0) {
        q('.card-of').textContent = `of ${fmtMin(budgetMin)} this week`;
        q('.bar').hidden = false;
        q('.bar-fill').style.width = `${Math.min(100, (tracked / (budgetMin * MIN)) * 100)}%`;
        const status = trackedMin > budgetMin ? `${fmtMin(trackedMin - budgetMin)} over`
          : trackedMin === budgetMin ? 'Budget reached'
          : `${fmtMin(budgetMin - trackedMin)} left`;
        q('.card-foot').textContent = `${status} · ${todayText}`;
      } else {
        // Budget of zero: tracked time only, no bar and no division.
        q('.card-of').textContent = 'this week';
        q('.bar').hidden = true;
        q('.card-foot').textContent = todayText;
      }
    }
  }

  // --------------------------------------------------------------- view: Week

  // Compares tracked time with where the budget says you should be by now.
  function paceHint(trackedMs, budgetMin, frac, isCurrent) {
    if (budgetMin <= 0) return null;
    const budgetMs = budgetMin * MIN;
    if (!isCurrent) {
      return trackedMs >= budgetMs
        ? { cls: 'ahead', text: 'Budget met' }
        : { cls: 'behind', text: `${fmtDur(budgetMs - trackedMs)} short` };
    }
    if (trackedMs >= budgetMs) return { cls: 'ahead', text: 'Budget met' };
    const diff = trackedMs - budgetMs * frac;
    const tolerance = Math.max(10 * MIN, budgetMs * 0.03);
    if (Math.abs(diff) < tolerance) return { cls: 'neutral', text: 'On pace' };
    return diff > 0
      ? { cls: 'ahead', text: `${fmtDur(diff)} ahead of pace` }
      : { cls: 'behind', text: `${fmtDur(-diff)} behind pace` };
  }

  function renderWeek() {
    const now = Date.now();
    const ws = addDays(weekStart(now), weekOffset * 7);
    const we = addDays(ws, 7);
    const isCurrent = weekOffset === 0;
    const totals = totalsIn(ws, we, now);
    const frac = isCurrent ? Math.min(1, Math.max(0, (now - ws) / (we - ws))) : 1;
    lastWeekMinute = Math.floor(now / MIN);

    const areas = state.areas.filter((a) => !a.archived || totals[a.id] > 0);
    const totalTracked = sumValues(totals);
    const budgeted = state.areas.filter((a) => !a.archived && a.weeklyBudgetMinutes > 0);
    const totalBudgetMin = budgeted.reduce((n, a) => n + a.weeklyBudgetMinutes, 0);
    const trackedInBudgeted = budgeted.reduce((n, a) => n + (totals[a.id] || 0), 0);
    const overall = paceHint(trackedInBudgeted, totalBudgetMin, frac, isCurrent);

    // Daily strip: each day is its own clipping window, so midnight splits sessions.
    const days = [];
    for (let i = 0; i < 7; i++) {
      const from = addDays(ws, i);
      const perArea = totalsIn(from, addDays(ws, i + 1), now);
      days.push({ from, perArea, total: sumValues(perArea) });
    }
    const maxDay = Math.max(...days.map((d) => d.total), 1);
    const todayStart = startOfDay(now);

    const label = isCurrent ? 'This week' : weekOffset === -1 ? 'Last week' : `${-weekOffset} weeks ago`;

    mount(
      h('header', { class: 'head' }, h('h1', null, 'Week')),
      h('div', { class: 'weeknav' },
        h('button', { type: 'button', class: 'round-btn', 'aria-label': 'Previous week', onclick: () => { weekOffset--; renderWeek(); } }, '‹'),
        h('div', { class: 'weeknav-label' },
          h('strong', null, `${fmtShortDate(ws)} – ${fmtShortDate(addDays(ws, 6))}`),
          h('span', null, label)),
        h('button', { type: 'button', class: 'round-btn', 'aria-label': 'Next week', disabled: isCurrent, onclick: () => { weekOffset++; renderWeek(); } }, '›')),

      h('section', { class: 'panel' },
        h('div', { class: 'muted' }, 'Total tracked'),
        h('div', { class: 'total-big num' }, fmtDur(totalTracked)),
        h('div', { class: 'muted num' }, totalBudgetMin > 0 ? `of ${fmtMin(totalBudgetMin)} budgeted` : 'No budgets set'),
        overall && h('div', { class: `pace ${overall.cls}`, style: 'margin-top:6px' }, overall.text),
        h('div', { class: 'days' }, days.map((d) => h('div', { class: d.from === todayStart ? 'day today' : 'day' },
          h('div', { class: 'day-col' }, state.areas
            .filter((a) => d.perArea[a.id] > 0)
            .map((a) => h('i', { style: `height:${(d.perArea[a.id] / maxDay) * 100}%;background:${a.color}` }))),
          h('span', null, new Date(d.from).toLocaleDateString([], { weekday: 'narrow' })),
          h('span', { class: 'num' }, d.total >= MIN ? fmtDur(d.total) : '–'))))),

      h('section', { class: 'panel' },
        areas.length ? areas.map((a) => {
          const tracked = totals[a.id] || 0;
          const trackedMin = Math.floor(tracked / MIN);
          const budgetMin = a.weeklyBudgetMinutes;
          // Past weeks are finished, so only the current week gets a pace hint.
          const hint = isCurrent ? paceHint(tracked, budgetMin, frac, true) : null;
          const remaining = budgetMin <= 0 ? 'No budget'
            : trackedMin > budgetMin ? `${fmtMin(trackedMin - budgetMin)} over`
            : trackedMin === budgetMin ? 'Budget met exactly'
            : `${fmtMin(budgetMin - trackedMin)} ${isCurrent ? 'remaining' : 'short of budget'}`;
          return h('div', { class: 'wrow', style: `--c:${a.color}` },
            h('div', { class: 'wrow-top' },
              h('span', { class: 'wrow-name' }, a.archived ? `${a.name} (archived)` : a.name),
              h('span', { class: 'wrow-nums num' }, h('b', null, fmtMin(trackedMin)),
                budgetMin > 0 && h('span', { class: 'muted' }, ` / ${fmtMin(budgetMin)}`))),
            budgetMin > 0 && h('div', { class: 'bar', style: `--c:${a.color}` },
              h('div', { class: 'bar-fill', style: `width:${Math.min(100, (tracked / (budgetMin * MIN)) * 100)}%` }),
              isCurrent && h('div', { class: 'bar-mark', style: `left:${frac * 100}%`, title: 'Where you should be by now' })),
            h('div', { class: 'wrow-foot num' },
              h('span', null, remaining),
              hint && h('span', { class: `pace ${hint.cls}` }, hint.text)));
        }) : h('p', { class: 'empty' }, 'No areas yet. Add one in Settings.')),

      isCurrent && totalBudgetMin > 0 && h('p', { class: 'footnote' },
        `The mark on each bar shows where an even pace would be right now (${Math.round(frac * 100)}% of the week has passed).`));
  }

  // ----------------------------------------------------------- view: Settings

  function renderSettings() {
    const active = state.areas.filter((a) => !a.archived);
    const archived = state.areas.filter((a) => a.archived);

    const areaRow = (a) => h('button', {
      type: 'button', class: a.archived ? 'row archived' : 'row', style: `--c:${a.color}`, onclick: () => openAreaSheet(a),
    },
      h('span', { class: 'dot' }),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-title' }, a.name),
        a.archived && h('div', { class: 'row-sub' }, 'Archived')),
      h('span', { class: 'row-end num' }, a.weeklyBudgetMinutes > 0 ? `${hoursText(a.weeklyBudgetMinutes)} h / week` : 'No budget'));

    // Sessions, newest first, grouped by the day they started.
    const sorted = [...state.sessions].sort((a, b) => b.startTs - a.startTs);
    const shown = sorted.slice(0, sessionsShown);
    const sessionNodes = [];
    let currentDay = null;
    let currentList = null;
    for (const s of shown) {
      const day = startOfDay(s.startTs);
      if (day !== currentDay) {
        currentDay = day;
        currentList = h('div', { class: 'list' });
        sessionNodes.push(h('div', { class: 'day-label' }, fmtDayLong(day)), currentList);
      }
      const area = areaById(s.areaId);
      const sameDay = startOfDay(s.endTs) === day;
      const range = `${fmtTime(s.startTs)} – ${sameDay ? '' : `${fmtDay(s.endTs)}, `}${fmtTime(s.endTs)}`;
      currentList.append(h('button', {
        type: 'button', class: 'row', style: `--c:${area ? area.color : '#888888'}`, onclick: () => openSessionSheet(s),
      },
        h('span', { class: 'dot' }),
        h('span', { class: 'row-main' },
          h('span', { class: 'row-title' }, area ? area.name : 'Unknown'),
          h('div', { class: 'row-sub num' }, s.note ? `${range} · ${s.note}` : range)),
        h('span', { class: 'row-end num' }, fmtDur(s.endTs - s.startTs))));
    }

    const weekSel = h('select', {
      'aria-label': 'Week starts on',
      onchange: (e) => { state.settings.weekStartsOn = Number(e.target.value); save(); },
    }, [1, 6, 0].map((d) => h('option', { value: String(d) }, WEEKDAYS[d])));
    weekSel.value = String(state.settings.weekStartsOn);
    if (weekSel.selectedIndex < 0) {
      weekSel.append(h('option', { value: String(state.settings.weekStartsOn) }, WEEKDAYS[state.settings.weekStartsOn]));
      weekSel.value = String(state.settings.weekStartsOn);
    }

    const warnIn = h('input', {
      type: 'text', inputmode: 'decimal', 'aria-label': 'Warn about long timers after hours',
      value: String(state.settings.longSessionWarnHours),
      onchange: (e) => {
        const n = Number(e.target.value.trim().replace(',', '.'));
        if (Number.isFinite(n) && n > 0 && n <= 168) {
          state.settings.longSessionWarnHours = n;
          save();
        } else {
          toast('Enter a number of hours between 0 and 168');
        }
        e.target.value = String(state.settings.longSessionWarnHours);
      },
    });

    let hasBackup = false;
    try { hasBackup = localStorage.getItem(BACKUP_KEY) !== null; } catch (e) { /* ignore */ }

    mount(
      h('header', { class: 'head' }, h('h1', null, 'Settings')),

      h('h2', { class: 'section' }, 'Areas'),
      h('div', { class: 'list' },
        active.map(areaRow),
        h('button', { type: 'button', class: 'row accent', onclick: () => openAreaSheet(null) }, '+ Add area')),
      archived.length > 0 && h('h2', { class: 'section' }, 'Archived areas'),
      archived.length > 0 && h('div', { class: 'list' }, archived.map(areaRow)),
      h('p', { class: 'footnote' }, 'Tap an area to rename it, change its color or budget, or archive it.'),

      h('h2', { class: 'section' }, 'Sessions'),
      h('div', { class: 'list' },
        h('button', { type: 'button', class: 'row accent', onclick: () => openSessionSheet(null) }, '+ Add manual session')),
      sessionNodes,
      !sorted.length && h('p', { class: 'footnote' }, 'No sessions yet. Start a timer on the Today tab.'),
      sorted.length > shown.length && h('div', { class: 'list', style: 'margin-top:16px' },
        h('button', { type: 'button', class: 'row accent', onclick: () => { sessionsShown += 50; renderSettings(); } },
          `Show older sessions (${sorted.length - shown.length} more)`)),

      h('h2', { class: 'section' }, 'Preferences'),
      h('div', { class: 'list' },
        h('label', { class: 'row' }, h('span', { class: 'row-main' }, 'Week starts on'), weekSel),
        h('label', { class: 'row' }, h('span', { class: 'row-main' }, 'Warn about timers longer than (hours)'), warnIn)),

      h('h2', { class: 'section' }, 'Data'),
      h('div', { class: 'list' },
        h('button', { type: 'button', class: 'row accent', onclick: exportData }, 'Export all data as JSON'),
        h('button', { type: 'button', class: 'row accent', onclick: () => $('#import-file').click() }, 'Import JSON…'),
        hasBackup && h('button', { type: 'button', class: 'row accent', onclick: exportCorruptBackup }, 'Export unreadable backup')),
      h('p', { class: 'footnote' }, 'Everything is stored only on this device. Export now and then to keep a backup.'));
  }

  // ---------------------------------------------------------------- rendering

  function render() {
    for (const btn of document.querySelectorAll('.tab')) {
      if (btn.dataset.tab === tab) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
    if (tab === 'today') renderToday();
    else if (tab === 'week') renderWeek();
    else renderSettings();
  }

  // Elapsed time is always recomputed from startTs and Date.now(). The interval
  // only triggers a repaint; if iOS suspends it, the next paint is still correct.
  function refreshLive() {
    if (document.hidden) return;
    if (tab === 'today') {
      fillToday();
    } else if (tab === 'week' && !closeSheet) {
      // The Week view shows minutes only, so repaint when the minute changes.
      if (Math.floor(Date.now() / MIN) !== lastWeekMinute) renderWeek();
    }
  }

  function onResume() {
    if (document.hidden) return;
    refreshLive();
    checkForgottenTimer();
  }

  // --------------------------------------------------------------------- boot

  function init() {
    state = load();
    save();

    for (const btn of document.querySelectorAll('.tab')) {
      btn.addEventListener('click', () => {
        tab = btn.dataset.tab;
        if (tab === 'week') weekOffset = 0;
        render();
        window.scrollTo(0, 0);
      });
    }

    $('#import-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = ''; // allow picking the same file again
      if (file) importFile(file);
    });

    render();
    setInterval(refreshLive, 1000);
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('focus', onResume);

    // Another tab or window of the app changed the data.
    window.addEventListener('storage', (e) => {
      if (e.key !== STORAGE_KEY || closeSheet) return;
      state = load();
      render();
    });

    if (bootMessage) toast(bootMessage, 6000);
    checkForgottenTimer();

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    }
  }

  init();
})();
