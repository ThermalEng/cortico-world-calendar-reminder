import type { Language } from 'cortico/core/language.ts';
import type { WebUiClientBundle, WebUiPanel } from 'cortico/web/shared/client-panel.ts';

export interface CalendarPanelItem {
  id: string;
  name: string;
  source: 'system' | 'caldav' | 'ics';
  count: number;
  enabled: boolean;
  writable: boolean;
  allowWrite: boolean;
}

export interface CalendarPanelState {
  lastSyncText: string;
  calendars: CalendarPanelItem[];
  errors: string[];
}

function panelCopy(language: Language) {
  const zh = language === 'zh' || language === 'zh-Hant';
  return {
    title: zh ? '日历选择与同步' : 'Calendars & Sync',
    syncBtn: zh ? '立即同步' : 'Sync now',
    syncing: zh ? '同步中…' : 'Syncing…',
    syncDone: zh ? '同步完成' : 'Sync completed',
    empty: zh ? '暂未发现日历，请先启用系统日历或填写 CalDAV 地址后点击「立即同步」。' : 'No calendars discovered yet. Enable system calendar or set CalDAV URL, then click Sync now.',
    hint: zh ? '勾选「提醒」接收日程通知；勾选「写入」允许 Coopanion 制定日程时写入该日历（只读 ICS 订阅不可写入）。' : 'Check "Remind" for notifications; check "Write" to allow Coopanion to create events in that calendar (read-only ICS feeds cannot be written).',
    remindCol: zh ? '提醒' : 'Remind',
    writeCol: zh ? '写入' : 'Write',
    readOnlyHint: zh ? '只读订阅不支持写入' : 'Read-only subscription',
    sourceLabel: (s: CalendarPanelItem['source']) => (s === 'caldav' ? 'CalDAV' : s === 'ics' ? 'ICS' : (zh ? '系统日历' : 'System')),
    countLabel: (n: number) => (zh ? `${n} 条日程` : `${n} events`),
  };
}

const panel: WebUiPanel = {
  mount(ctx) {
    const { ui } = ctx;
    const t = panelCopy(ctx.language);
    const sheet = ui.sheet({ title: t.title });

    const topRow = ui.h('div');
    topRow.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:8px';
    const syncBtn = ui.button(t.syncBtn, { size: 'sm', variant: 'primary' });
    const statusPill = ui.pill('', 'plain');
    topRow.append(syncBtn, statusPill);

    const hintEl = ui.h('p', '', t.hint);
    const errorEl = ui.h('small');
    errorEl.style.cssText = 'display:block;color:var(--bad, #dc2626);margin-bottom:8px;white-space:pre-wrap';

    const listEl = ui.h('div');
    listEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding-top:4px';

    sheet.body.append(topRow, hintEl, errorEl, listEl);
    ctx.root.append(sheet.el);

    let busy = false;

    function makeCheck(labelText: string, checked: boolean, disabled: boolean, title: string, onChange: (v: boolean) => void) {
      const lbl = document.createElement('label');
      lbl.style.cssText = `display:inline-flex;align-items:center;gap:4px;cursor:${disabled ? 'not-allowed' : 'pointer'};opacity:${disabled ? '0.5' : '1'}`;
      if (title) lbl.title = title;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = checked;
      box.disabled = disabled;
      box.style.cssText = `width:15px;height:15px;cursor:${disabled ? 'not-allowed' : 'pointer'}`;
      box.addEventListener('change', () => onChange(box.checked), { signal: ctx.signal });
      lbl.append(box, document.createTextNode(labelText));
      return lbl;
    }

    function render(state: CalendarPanelState) {
      if (ctx.signal.aborted) return;
      statusPill.textContent = state.lastSyncText;
      statusPill.className = `pill ${state.errors.length > 0 ? 'off' : 'on'}`;
      errorEl.textContent = state.errors.length > 0 ? state.errors.join('\n') : '';

      listEl.replaceChildren();
      if (state.calendars.length === 0) {
        listEl.append(ui.h('p', '', t.empty));
        return;
      }

      for (const cal of state.calendars) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:6px 4px;border-radius:6px';

        const remindCheck = makeCheck(t.remindCol, cal.enabled, busy, '', (v) => void invokeMethod('toggle', [cal.id, v]));
        const writeCheck = makeCheck(
          t.writeCol,
          cal.allowWrite,
          busy || !cal.writable,
          cal.writable ? '' : t.readOnlyHint,
          (v) => void invokeMethod('toggleWrite', [cal.id, v]),
        );

        const nameEl = ui.h('strong', '', cal.name);
        nameEl.style.cssText = 'flex:1;min-width:120px';

        const srcPill = ui.pill(t.sourceLabel(cal.source), 'plain');
        const cntEl = ui.h('small', '', t.countLabel(cal.count));

        row.append(remindCheck, writeCheck, nameEl, srcPill, cntEl);
        listEl.append(row);
      }
    }

    async function invokeMethod(method: string, args: unknown[]) {
      if (busy) return;
      busy = true;
      try {
        const state = await ctx.invoke<CalendarPanelState>(method, args);
        render(state);
      } catch (error) {
        if (!ctx.signal.aborted) ui.toast(error instanceof Error ? error.message : String(error), 'bad');
      } finally {
        busy = false;
      }
    }

    async function doSync() {
      if (busy) return;
      busy = true;
      syncBtn.disabled = true;
      syncBtn.textContent = t.syncing;
      try {
        const state = await ctx.invoke<CalendarPanelState>('sync');
        render(state);
        if (!ctx.signal.aborted) {
          ui.toast(t.syncDone, state.errors.length > 0 ? 'bad' : 'ok');
        }
      } catch (error) {
        if (!ctx.signal.aborted) ui.toast(error instanceof Error ? error.message : String(error), 'bad');
      } finally {
        busy = false;
        syncBtn.disabled = false;
        syncBtn.textContent = t.syncBtn;
      }
    }

    syncBtn.addEventListener('click', () => void doSync(), { signal: ctx.signal });

    void ctx.invoke<CalendarPanelState>('state').then(render).catch((error) => {
      if (!ctx.signal.aborted) ui.toast(String(error), 'bad');
    });
  },
};

export default { panels: { calendars: panel } } satisfies WebUiClientBundle;
