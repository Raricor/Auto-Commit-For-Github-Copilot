import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommitCandidate, PlannedGroup } from '../src/types';
import {
    canSubmit,
    commitPayload,
    computeDisplayMoves,
    initialState,
    isCommitBusy,
    reducer,
    selectedIds,
    slotKey,
} from '../src/webview/state';
import type { Action, AppState } from '../src/webview/state';

const settings = { conventionalCommits: true, language: 'en' as const };

function run(state: AppState, ...actions: Action[]): AppState {
    return actions.reduce(reducer, state);
}

function candidate(id: string, checked = true): CommitCandidate {
    return {
        id,
        message: `feat: ${id}`,
        reason: `reason ${id}`,
        files: [`${id}.ts`],
        checked,
    };
}

function groups(count: number): PlannedGroup[] {
    return Array.from({ length: count }, (_, index) => ({
        index,
        label: `Group ${index}`,
        files: [`group-${index}.ts`],
    }));
}

function planned(count: number): AppState {
    return run(
        initialState,
        { type: 'SET_LOADING' },
        { type: 'GROUPS_PLANNED', groups: groups(count) },
    );
}

test('groupsPlanned creates pending slots and out-of-order candidates fill the matching slot', () => {
    let state = planned(3);
    assert.deepEqual(state.slots.map((slot) => slot.status), ['pending', 'pending', 'pending']);
    assert.deepEqual(state.progress, { stage: 'grouping' });

    state = run(
        state,
        { type: 'ADD_CANDIDATE', candidate: candidate('b'), groupIndex: 1 },
        { type: 'ADD_CANDIDATE', candidate: candidate('a'), groupIndex: 0 },
    );

    assert.deepEqual(state.slots.map((slot) => slot.status), ['ready', 'ready', 'pending']);
    assert.deepEqual(state.slots.map((slot) => slot.candidate?.id), ['a', 'b', undefined]);
    assert.deepEqual(state.slots.map((slot) => slot.label), ['Group 0', 'Group 1', 'Group 2']);
    assert.equal(slotKey(state.slots[0]), 'candidate:a');
});

test('addCandidate with an unknown group index appends a slot', () => {
    let state = planned(1);
    state = run(state, { type: 'ADD_CANDIDATE', candidate: candidate('late'), groupIndex: 99 });

    assert.equal(state.slots.length, 2);
    assert.equal(state.slots[1].groupIndex, 99);
    assert.equal(state.slots[1].status, 'ready');
    assert.equal(state.slots[1].candidate?.id, 'late');
});

test('groupFailed -> retrying -> successful candidate becomes ready', () => {
    let state = run(planned(2), { type: 'DONE' });
    const first = groups(2)[0];

    state = run(state, { type: 'GROUP_FAILED', group: first, message: 'model timed out' });
    assert.equal(state.slots[0].status, 'failed');
    assert.equal(state.slots[0].error, 'model timed out');

    state = run(state, { type: 'RETRY_GROUP', groupIndex: 0 });
    assert.equal(state.slots[0].status, 'retrying');
    assert.equal(state.slots[0].error, undefined);
    assert.equal(isCommitBusy(state), true);
    assert.equal(canSubmit(state), false);
    assert.deepEqual(selectedIds(state), []);

    state = run(state, { type: 'ADD_CANDIDATE', candidate: candidate('a'), groupIndex: 0 });
    assert.equal(state.slots[0].status, 'ready');
    assert.equal(state.slots[0].candidate?.id, 'a');
    assert.equal(isCommitBusy(state), false);
});

test('reorder uses listed ids first, ignores unknown ids, and leaves other slots in place', () => {
    let state = planned(3);
    state = run(
        state,
        { type: 'ADD_CANDIDATE', candidate: candidate('a'), groupIndex: 0 },
        { type: 'ADD_CANDIDATE', candidate: candidate('b'), groupIndex: 1 },
        { type: 'ADD_CANDIDATE', candidate: candidate('c'), groupIndex: 2 },
    );

    state = run(state, { type: 'AI_REORDER', ids: ['c', 'missing', 'a'] });

    assert.deepEqual(state.slots.map((slot) => slot.candidate?.id), ['c', 'a', 'b']);
    assert.notEqual(state.aiReorder, null);
    assert.deepEqual(state.reorderBadges?.moves, { c: -2, a: 1, b: 1 });

    state = run(state, { type: 'UNDO_REORDER' });
    assert.deepEqual(state.slots.map((slot) => slot.candidate?.id), ['a', 'b', 'c']);
    assert.equal(state.aiReorder, null);
});

test('manual drag makes the AI reorder undo unavailable', () => {
    let state = planned(3);
    state = run(
        state,
        { type: 'ADD_CANDIDATE', candidate: candidate('a'), groupIndex: 0 },
        { type: 'ADD_CANDIDATE', candidate: candidate('b'), groupIndex: 1 },
        { type: 'ADD_CANDIDATE', candidate: candidate('c'), groupIndex: 2 },
        { type: 'AI_REORDER', ids: ['c', 'b', 'a'] },
    );
    assert.notEqual(state.aiReorder, null);

    const manual = [...state.slots].reverse();
    state = run(state, { type: 'REORDER_SLOTS', slots: manual });
    assert.equal(state.aiReorder, null);
    assert.equal(state.reorderBadges, null);
    assert.deepEqual(state.slots.map((slot) => slot.candidate?.id), ['a', 'b', 'c']);

    const afterManual = state;
    state = run(state, { type: 'UNDO_REORDER' });
    assert.equal(state, afterManual);
    assert.deepEqual(state.slots.map((slot) => slot.candidate?.id), ['a', 'b', 'c']);
});

test('commit payload contains only ready slots, in slot order, and ids only for checked ones', () => {
    let state = run(planned(4), { type: 'DONE' });
    state = run(
        state,
        { type: 'ADD_CANDIDATE', candidate: candidate('b'), groupIndex: 1 },
        { type: 'ADD_CANDIDATE', candidate: candidate('a'), groupIndex: 0 },
        { type: 'ADD_CANDIDATE', candidate: candidate('c'), groupIndex: 2 },
        { type: 'ADD_CANDIDATE', candidate: candidate('d', false), groupIndex: 3 },
        { type: 'AI_REORDER', ids: ['c', 'a', 'b', 'd'] },
        { type: 'GROUP_FAILED', group: groups(4)[3], message: 'failed' },
    );

    const payload = commitPayload(state);
    assert.deepEqual(payload.orderedCandidates.map((c) => c.id), ['c', 'a', 'b']);
    assert.deepEqual(payload.ids, ['c', 'a', 'b']);
    assert.deepEqual(selectedIds(state), ['c', 'a', 'b']);
    assert.equal(canSubmit(state), true);

    state = run(state, { type: 'RETRY_GROUP', groupIndex: 1 });
    const retryingPayload = commitPayload(state);
    assert.deepEqual(retryingPayload.orderedCandidates.map((c) => c.id), ['c', 'a']);
    assert.deepEqual(retryingPayload.ids, ['c', 'a']);
    assert.equal(canSubmit(state), false);
});

test('display movement counts use reversed display order (positive means up)', () => {
    assert.deepEqual(
        computeDisplayMoves(['a', 'b', 'c'], ['c', 'a', 'b']),
        { c: -2, a: 1, b: 1 }
    );
    assert.deepEqual(
        computeDisplayMoves(['a', 'b'], ['b', 'a']),
        { b: -1, a: 1 }
    );
    assert.deepEqual(computeDisplayMoves(['a', 'b'], ['a', 'b']), {});
});

test('legacy addCandidate without groupIndex still appends ready slots', () => {
    let state = run(initialState, { type: 'SET_LOADING' });
    state = run(
        state,
        { type: 'ADD_CANDIDATE', candidate: candidate('first') },
        { type: 'ADD_CANDIDATE', candidate: candidate('second') },
    );

    assert.deepEqual(state.slots.map((slot) => slot.status), ['ready', 'ready']);
    assert.deepEqual(state.slots.map((slot) => slot.candidate?.id), ['first', 'second']);
    assert.equal(state.slots[0].groupIndex, -1);
    assert.equal(state.slots[1].groupIndex, -2);
    assert.notEqual(slotKey(state.slots[0]), slotKey(state.slots[1]));
});

test('loading clears slots, notices and reorder state and starts grouping', () => {
    let state = planned(2);
    state = run(
        state,
        { type: 'ADD_CANDIDATE', candidate: candidate('a'), groupIndex: 0 },
        { type: 'NOTICE', level: 'info', message: 'hello' },
        { type: 'AI_REORDER', ids: ['a'] },
        { type: 'SET_LOADING' },
    );

    assert.deepEqual(state.slots, []);
    assert.deepEqual(state.notices, []);
    assert.equal(state.aiReorder, null);
    assert.equal(state.reorderBadges, null);
    assert.equal(state.generating, true);
    assert.deepEqual(state.progress, { stage: 'grouping' });
});

test('notices can be dismissed and duplicate ids stay unique', () => {
    let state = run(
        initialState,
        { type: 'NOTICE', level: 'info', message: 'first' },
        { type: 'NOTICE', level: 'warning', message: 'second' },
    );

    assert.equal(state.notices.length, 2);
    assert.notEqual(state.notices[0].id, state.notices[1].id);
    assert.equal(state.notices[1].level, 'warning');

    const id = state.notices[0].id;
    state = run(state, { type: 'DISMISS_NOTICE', id });
    assert.deepEqual(state.notices.map((notice) => notice.message), ['second']);
});

test('committed removes matching candidates, keeps pending slots and sets success', () => {
    let state = planned(3);
    state = run(
        state,
        { type: 'SET_COMMITTING', committing: true },
        { type: 'ADD_CANDIDATE', candidate: candidate('a'), groupIndex: 0 },
        { type: 'ADD_CANDIDATE', candidate: candidate('b'), groupIndex: 1 },
        { type: 'COMMITTED', count: 1, ids: ['a'] },
    );

    assert.equal(state.committing, false);
    assert.deepEqual(state.slots.map((slot) => slot.status), ['ready', 'pending']);
    assert.equal(state.slots[0].candidate?.id, 'b');
    assert.equal(state.success, '1 commit created successfully.');
});

test('diff content is cached and a staged-file refresh clears the cache', () => {
    let state = run(
        initialState,
        { type: 'SET_DIFF_CONTENT', path: 'a.ts', content: '+hello' },
    );
    assert.equal(state.diffCache['a.ts'], '+hello');

    state = run(state, {
        type: 'SET_STAGED_FILES',
        files: [{ path: 'a.ts', type: 'modified', diff: '', diffOmitted: true, additions: 1, deletions: 0 }],
    });
    assert.deepEqual(state.diffCache, {});
    assert.equal(state.stagedLoading, false);
    assert.equal(state.stagedFiles[0].diffOmitted, true);
});

test('settings and candidate updates stay immutable', () => {
    let state = planned(1);
    state = run(
        state,
        { type: 'ADD_CANDIDATE', candidate: candidate('a'), groupIndex: 0 },
        { type: 'TOGGLE_CANDIDATE', id: 'a' },
        { type: 'UPDATE_CANDIDATE_MESSAGE', id: 'a', message: 'fix: edited' },
        { type: 'UPDATE_SETTING', key: 'reasoningEffort', value: 'high' },
        { type: 'UPDATE_SETTING', key: 'minCommits', value: 2 },
        { type: 'SET_SETTINGS', settings },
    );

    assert.equal(state.slots[0].candidate?.checked, false);
    assert.equal(state.slots[0].candidate?.message, 'fix: edited');
    assert.deepEqual(state.settings, settings);
});
