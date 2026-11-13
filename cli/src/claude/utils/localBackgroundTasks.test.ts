import { describe, it, expect } from 'vitest';
import { createLocalBackgroundTasks, bindLocalBackgroundTasks, endLocalBackgroundTasks } from './localBackgroundTasks';

const start = (id: string) => ({ type: 'user', toolUseResult: { backgroundTaskId: id }, message: { content: [] } });
const stop = (id: string, status: string) => ({ type: 'user', message: { content: `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>` } });
function fixture() {
    const sent: { type: string; subtype: string; tasks: { task_id: string }[] }[] = [];
    return { sent, tracker: createLocalBackgroundTasks(message => sent.push(message)) };
}
describe('local transcript background tasks', () => {
    it.each(['completed', 'failed', 'killed', 'cancelled'])('removes %s once', status => {
        const { sent, tracker } = fixture();
        tracker.consume(start('a'));
        tracker.consume(start('a'));
        expect(sent).toHaveLength(1);
        expect(sent[0].tasks.map(task => task.task_id)).toEqual(['a']);
        tracker.consume(stop('a', status));
        tracker.consume(stop('a', status));
        expect(sent).toHaveLength(2);
        expect(sent[1].tasks).toEqual([]);
    });
    it('restores only the final startup snapshot', () => {
        const { sent, tracker } = fixture();
        for (const message of [start('a'), start('b'), stop('b', 'completed')]) tracker.consume(message, false);
        expect(sent).toHaveLength(0);
        tracker.publish();
        expect(sent.map(message => message.tasks.map(task => task.task_id))).toEqual([['a']]);
        expect(sent[0]).toMatchObject({ type: 'system', subtype: 'background_tasks_changed' });
    });
    it('clears on exit or hook and rejects late starts', () => {
        const { sent, tracker } = fixture();
        const owner = {};
        const unbind = bindLocalBackgroundTasks(owner, () => tracker.end());
        tracker.consume(start('a'));
        endLocalBackgroundTasks(owner);
        tracker.consume(start('late'));
        tracker.end();
        expect(sent).toHaveLength(2);
        expect(sent[1].tasks).toEqual([]);
        unbind();
    });
    it('does not interpret prose or nonterminal notices as lifecycle signals', () => {
        const { sent, tracker } = fixture();
        tracker.consume({ type: 'assistant', message: { content: '我在等：后台在跑' }, toolUseResult: { backgroundTaskId: 'fake' } });
        tracker.consume({ type: 'user', message: { content: '/tmp/a.output 后台在跑' } });
        expect(sent).toHaveLength(0);
        tracker.consume(start('a'));
        tracker.consume(stop('a', 'running'));
        expect(sent).toHaveLength(1);
        expect(sent[0].tasks).toHaveLength(1);
    });
});
