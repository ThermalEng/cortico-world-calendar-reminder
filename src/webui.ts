import type { Language } from 'cortico/core/language.ts';
import type { WebUiClientBundle, WebUiPanel } from 'cortico/web/shared/client-panel.ts';

export interface CalendarPanelItem {
  id: string;
  name: string;
  source: 'system' | 'caldav' | 'ics';
  count: number;
  enabled: boolean;
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
    hint: zh ? '勾选需要提醒的日历；取消勾选的日历将不会触发提醒或出现在待办列表中。' : 'Check the calendars you want reminders from. Unchecked calendars are muted.',
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
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 4px;cursor:pointer;border-radius:6px';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = cal.enabled;
        checkbox.disabled = busy;
        checkbox.style.cssText = 'width:16px;height:16px;cursor:pointer';
        checkbox.addEventListener('change', () => {
          void toggleCalendar(cal.id, checkbox.checked);
        }, { signal: ctx.signal });

        const nameEl = ui.h('strong', '', cal.name);
        nameEl.style.cssText = 'flex:1;min-width:120px';

        const srcPill = ui.pill(t.sourceLabel(cal.source), 'plain');
        const cntEl = ui.h('small', '', t.countLabel(cal.count));

        label.append(checkbox, nameEl, srcPill, cntEl);
        listEl.append(label);
      }
    }

    async function toggleCalendar(id: string, enabled: boolean) {
      if (busy) return;
      busy = true;
      try {
        const state = await ctx.invoke<CalendarPanelState>('toggle', [id, enabled]);
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
