import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    LIST_REFRESH_MIN_GAP_MS,
    OFFLINE_VERIFY_DELAY_MS,
    bindListOfflineVerifier,
    createListOnlinePageController,
    createListRefreshGate,
    createOfflineVerifier,
    deliverListedSessionPatch,
    deliverListedSessionUpsert,
    noteListWentOffline,
    notePatchOffline,
    planSessionListRefresh,
    readSessionActive,
    removeSummary,
    setDetailActive,
    setSummaryActive
} from './listOnlineFreshness.ts';

function fakeSchedule() {
    const timers = [];
    return {
        timers,
        schedule(delay, run) {
            const timer = { delay, run, cancelled: false };
            timers.push(timer);
            return { cancel() { timer.cancelled = true; } };
        }
    };
}

function fakeEventTarget() {
    const listeners = new Map();
    return {
        addEventListener(type, listener) {
            const list = listeners.get(type) ?? [];
            list.push(listener);
            listeners.set(type, list);
        },
        removeEventListener(type, listener) {
            const list = listeners.get(type) ?? [];
            listeners.set(type, list.filter((item) => item !== listener));
        },
        dispatch(type) {
            const list = (listeners.get(type) ?? []).slice();
            for (const listener of list) {
                listener();
            }
        }
    };
}

function openListPage(options) {
    const clock = fakeSchedule();
    const target = fakeEventTarget();
    const listApplied = [];
    const detailApplied = [];
    const removed = [];
    const lists = [];
    let now = 0;
    let visibility = 'hidden';
    const gate = createListRefreshGate();
    const controller = createListOnlinePageController({
        schedule: clock.schedule,
        fetchSession: options.fetchSession,
        writeListActive(id, active) {
            listApplied.push(active);
            if (options.onList) {
                options.onList(id, active);
            }
        },
        writeDetailActive(id, active) {
            detailApplied.push(active);
            if (options.onDetail) {
                options.onDetail(id, active);
            }
        },
        removeSession(id) {
            removed.push(id);
        }
    });
    controller.attachVisibility({
        eventTarget: target,
        readVisibility: () => visibility,
        getGate: () => gate,
        now: () => now,
        invalidateList: () => lists.push(now)
    });
    return {
        clock,
        target,
        listApplied,
        detailApplied,
        removed,
        lists,
        gate,
        controller,
        setNow(value) { now = value; },
        setVisibility(value) { visibility = value; }
    };
}

test('前台恢复触发重取并受限频', () => {
    assert.equal(LIST_REFRESH_MIN_GAP_MS, 5000);
    const gate = createListRefreshGate();
    const lists = [];
    const messages = [];
    const apply = (reason, now, extra = {}) => {
        const plan = planSessionListRefresh({ reason, now, gate, ...extra });
        if (plan.refreshList) {
            lists.push(now);
        }
        if (plan.refreshMessages) {
            messages.push(reason);
        }
    };

    apply('visible', 0);
    apply('visible', LIST_REFRESH_MIN_GAP_MS - 1);
    apply('visible', LIST_REFRESH_MIN_GAP_MS);
    assert.deepEqual(lists, [0, LIST_REFRESH_MIN_GAP_MS]);
    assert.deepEqual(messages, []);

    apply('connect', LIST_REFRESH_MIN_GAP_MS + 1000, { resumed: true, isFirstConnect: false });
    assert.deepEqual(lists, [0, LIST_REFRESH_MIN_GAP_MS]);
    assert.deepEqual(messages, []);

    const messagesStillRefresh = planSessionListRefresh({
        reason: 'connect',
        resumed: false,
        isFirstConnect: false,
        now: LIST_REFRESH_MIN_GAP_MS + 1000,
        gate
    });
    assert.equal(messagesStillRefresh.refreshList, false);
    assert.equal(messagesStillRefresh.refreshMessages, true);
});

test('在线变不在线核实一次，结果为在线时绿点恢复', async () => {
    assert.equal(OFFLINE_VERIFY_DELAY_MS, 2000);
    const list = { sessions: [{ id: 's1', active: true }] };
    const detail = { session: { id: 's1', active: true } };
    const fetches = [];
    let stored = null;
    const verifier = createOfflineVerifier({
        schedule(delay, run) {
            stored = { delay, run };
            return { cancel() { stored.cancelled = true; } };
        },
        fetchSession(id) {
            fetches.push(id);
            return Promise.resolve({ status: 200, active: true });
        },
        applyActive(id, active) {
            const nextList = setSummaryActive(list, id, active);
            list.sessions = nextList.sessions;
            const nextDetail = setDetailActive(detail, active);
            detail.session = nextDetail.session;
        },
        onMissing() {
            throw new Error('online result must not delete the session');
        }
    });

    list.sessions[0] = { ...list.sessions[0], active: false };
    detail.session = { ...detail.session, active: false };
    verifier.noteDrop('s1');
    assert.equal(fetches.length, 0);
    assert.equal(stored.delay, OFFLINE_VERIFY_DELAY_MS);
    await stored.run();
    assert.deepEqual(fetches, ['s1']);
    assert.equal(list.sessions[0].active, true);
    assert.equal(detail.session.active, true);
});

test('同一会话连续两次掉线只核实一次', async () => {
    const fetches = [];
    let release = null;
    const timers = [];
    const verifier = createOfflineVerifier({
        schedule(delay, run) {
            const timer = { delay, run, cancelled: false };
            timers.push(timer);
            return { cancel() { timer.cancelled = true; } };
        },
        fetchSession(id) {
            fetches.push(id);
            return new Promise((resolve) => {
                release = () => resolve({ status: 200, active: false });
            });
        },
        applyActive() {},
        onMissing() {
            throw new Error('this result is not a deletion');
        }
    });

    verifier.noteDrop('s1');
    verifier.noteDrop('s1');
    assert.equal(timers.length, 1);
    const pending = timers[0].run();
    verifier.noteDrop('s1');
    assert.equal(timers.length, 1);
    assert.deepEqual(fetches, ['s1']);
    release();
    await pending;
    assert.deepEqual(fetches, ['s1']);
});

test('只有 contentRevision 和 readState 的补丁不触发核实', () => {
    let notes = 0;
    const note = () => {
        notes += 1;
    };
    notePatchOffline(true, { contentRevision: 4, readState: { version: 2 } }, note);
    notePatchOffline(true, {}, note);
    notePatchOffline(false, { active: false }, note);
    notePatchOffline(true, { active: true, contentRevision: 5 }, note);
    assert.equal(notes, 0);
    notePatchOffline(true, { active: false, contentRevision: 6, readState: { version: 3 } }, note);
    assert.equal(notes, 1);
});

test('核实返回 404 时走会话删除，不写回在线值', async () => {
    const list = { sessions: [{ id: 's1', active: false }, { id: 's2', active: true }] };
    let applied = 0;
    let removed = null;
    let stored = null;
    const verifier = createOfflineVerifier({
        schedule(delay, run) {
            stored = { delay, run };
            return { cancel() {} };
        },
        fetchSession() {
            return Promise.resolve({ status: 404 });
        },
        applyActive() {
            applied += 1;
        },
        onMissing(id) {
            removed = removeSummary(list, id);
        }
    });
    verifier.noteDrop('s1');
    await stored.run();
    assert.equal(applied, 0);
    assert.deepEqual(removed.sessions.map((item) => item.id), ['s2']);
});

test('读取核实结果时保留布尔在线值并认出 404', async () => {
    const online = await readSessionActive(async () => ({ session: { active: true } }), 's1');
    assert.deepEqual(online, { status: 200, active: true });
    const missing = await readSessionActive(async () => {
        const error = new Error('missing');
        error.status = 404;
        throw error;
    }, 's1');
    assert.equal(missing.status, 404);
    assert.equal(Object.hasOwn(missing, 'active'), false);
});

test('共享入口把同一会话的掉线合并成一次核实', async () => {
    const fetches = [];
    const timers = [];
    const verifier = createOfflineVerifier({
        schedule(delay, run) {
            timers.push({ delay, run });
            return { cancel() {} };
        },
        fetchSession(id) {
            fetches.push(id);
            return Promise.resolve({ status: 200, active: true });
        },
        applyActive() {},
        onMissing() {}
    });
    bindListOfflineVerifier(verifier);
    try {
        noteListWentOffline('s9');
        noteListWentOffline('s9');
        assert.equal(timers.length, 1);
        await timers[0].run();
        assert.deepEqual(fetches, ['s9']);
    } finally {
        bindListOfflineVerifier(null);
    }
});

test('页面注册的前台监听会重取列表，5秒内不重复，卸下后不再听', () => {
    const page = openListPage({
        fetchSession() {
            return Promise.resolve({ status: 200, active: true });
        }
    });
    try {
        page.target.dispatch('visibilitychange');
        page.setVisibility('visible');
        page.target.dispatch('visibilitychange');
        page.setNow(LIST_REFRESH_MIN_GAP_MS - 1);
        page.target.dispatch('visibilitychange');
        page.setNow(LIST_REFRESH_MIN_GAP_MS);
        page.target.dispatch('visibilitychange');
        assert.deepEqual(page.lists, [0, LIST_REFRESH_MIN_GAP_MS]);
        assert.deepEqual(page.listApplied, []);
        assert.deepEqual(page.detailApplied, []);
        const connect = planSessionListRefresh({
            reason: 'connect',
            resumed: true,
            isFirstConnect: false,
            now: LIST_REFRESH_MIN_GAP_MS,
            gate: page.gate
        });
        assert.equal(connect.refreshList, false);
        assert.equal(connect.refreshMessages, false);
        page.controller.dispose();
        page.setNow(LIST_REFRESH_MIN_GAP_MS * 2);
        page.target.dispatch('visibilitychange');
        assert.deepEqual(page.lists, [0, LIST_REFRESH_MIN_GAP_MS]);
    } finally {
        page.controller.dispose();
    }
});

test('页面事件入口收到掉线后，核实为在线会写回列表和详情', async () => {
    const list = { sessions: [{ id: 's1', active: false }] };
    const detail = { session: { id: 's1', active: false } };
    const page = openListPage({
        fetchSession() {
            return Promise.resolve({ status: 200, active: true });
        },
        onList(id, active) {
            const next = setSummaryActive(list, id, active);
            list.sessions = next.sessions;
        },
        onDetail(_id, active) {
            const next = setDetailActive(detail, active);
            detail.session = next.session;
        }
    });
    try {
        deliverListedSessionUpsert(true, { id: 's1', active: false });
        assert.equal(page.clock.timers.length, 1);
        assert.equal(page.clock.timers[0].delay, OFFLINE_VERIFY_DELAY_MS);
        await page.clock.timers[0].run();
        assert.equal(list.sessions[0].active, true);
        assert.equal(detail.session.active, true);
        assert.deepEqual(page.listApplied, [true]);
        assert.deepEqual(page.detailApplied, [true]);
    } finally {
        page.controller.dispose();
    }
});

test('GET 等待期间收到更新就丢弃；又掉线再核实一次', async () => {
    const releases = [];
    const page = openListPage({
        fetchSession() {
            return new Promise((resolve) => {
                releases.push(resolve);
            });
        }
    });
    try {
        deliverListedSessionPatch(true, 's1', { active: false });
        assert.equal(page.clock.timers.length, 1);
        const first = page.clock.timers[0].run();
        deliverListedSessionPatch(false, 's1', { active: true });
        releases[0]({ status: 200, active: false });
        await first;
        assert.deepEqual(page.listApplied, []);
        assert.deepEqual(page.detailApplied, []);
        assert.equal(page.clock.timers.length, 1);

        deliverListedSessionUpsert(true, { id: 's1', active: false });
        const secondWait = page.clock.timers[1].run();
        deliverListedSessionUpsert(false, { id: 's1', active: true });
        deliverListedSessionUpsert(true, { id: 's1', active: false });
        releases[1]({ status: 200, active: false });
        await secondWait;
        assert.deepEqual(page.listApplied, []);
        assert.deepEqual(page.detailApplied, []);
        assert.equal(page.clock.timers.length, 3);
        const third = page.clock.timers[2].run();
        releases[2]({ status: 200, active: true });
        await third;
        assert.deepEqual(page.listApplied, [true]);
        assert.deepEqual(page.detailApplied, [true]);
    } finally {
        page.controller.dispose();
    }
});

test('请求期间在线、掉线、再在线后，旧结果回来不再核实', async () => {
    const releases = [];
    const fetches = [];
    const page = openListPage({
        fetchSession(id) {
            fetches.push(id);
            return new Promise((resolve) => {
                releases.push(resolve);
            });
        }
    });
    try {
        deliverListedSessionUpsert(true, { id: 's1', active: false });
        assert.equal(page.clock.timers.length, 1);
        const first = page.clock.timers[0].run();
        deliverListedSessionUpsert(false, { id: 's1', active: true });
        deliverListedSessionUpsert(true, { id: 's1', active: false });
        deliverListedSessionUpsert(false, { id: 's1', active: true });
        releases[0]({ status: 200, active: false });
        await first;
        assert.deepEqual(page.listApplied, []);
        assert.deepEqual(page.detailApplied, []);
        assert.deepEqual(fetches, ['s1']);
        assert.equal(page.clock.timers.length, 1);
    } finally {
        page.controller.dispose();
    }
});

test('核实请求等待期间只有内容或已读更新时，丢弃结果且不再核实', async () => {
    let release = null;
    const page = openListPage({
        fetchSession() {
            return new Promise((resolve) => {
                release = resolve;
            });
        }
    });
    try {
        deliverListedSessionPatch(true, 's1', { active: false });
        const pending = page.clock.timers[0].run();
        deliverListedSessionPatch(false, 's1', { contentRevision: 4, readState: { version: 2 } });
        release({ status: 200, active: true });
        await pending;
        assert.deepEqual(page.listApplied, []);
        assert.deepEqual(page.detailApplied, []);
        assert.equal(page.clock.timers.length, 1);
    } finally {
        page.controller.dispose();
    }
});

test('页面事件入口核实返回 404 时走删除，不写回在线值', async () => {
    const page = openListPage({
        fetchSession() {
            return Promise.resolve({ status: 404 });
        }
    });
    try {
        deliverListedSessionUpsert(true, { id: 's1', active: false });
        await page.clock.timers[0].run();
        assert.deepEqual(page.removed, ['s1']);
        assert.deepEqual(page.listApplied, []);
        assert.deepEqual(page.detailApplied, []);
    } finally {
        page.controller.dispose();
    }
});

test('页面卸下后，还没发出和已经发出的核实都不写回缓存', async () => {
    const fetches = [];
    const waiting = openListPage({
        fetchSession(id) {
            fetches.push(id);
            return Promise.resolve({ status: 200, active: true });
        }
    });
    try {
        deliverListedSessionUpsert(true, { id: 's1', active: false });
        waiting.controller.dispose();
        assert.equal(waiting.clock.timers[0].cancelled, true);
        await waiting.clock.timers[0].run();
        assert.deepEqual(fetches, []);
        assert.deepEqual(waiting.listApplied, []);
        assert.deepEqual(waiting.detailApplied, []);
    } finally {
        waiting.controller.dispose();
    }

    const releases = [];
    const inflight = openListPage({
        fetchSession() {
            return new Promise((resolve) => {
                releases.push(resolve);
            });
        }
    });
    try {
        deliverListedSessionUpsert(true, { id: 's2', active: false });
        const pending = inflight.clock.timers[0].run();
        inflight.controller.dispose();
        releases[0]({ status: 200, active: true });
        await pending;
        assert.deepEqual(inflight.listApplied, []);
        assert.deepEqual(inflight.detailApplied, []);
    } finally {
        inflight.controller.dispose();
    }
});
