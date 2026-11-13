import { randomUUID } from 'node:crypto';

type Snapshot = {
    type: 'system';
    subtype: 'background_tasks_changed';
    uuid: string;
    tasks: { task_id: string; task_type: string; description: string }[];
};
function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

/** Local JSONL has starts and terminal notifications, not SDK task snapshots. */
export function createLocalBackgroundTasks(send: (message: Snapshot) => void) {
    const running = new Set<string>();
    let ended = false;
    const publish = () => send({
        type: 'system', subtype: 'background_tasks_changed', uuid: randomUUID(),
        tasks: [...running].map(task_id => ({ task_id, task_type: 'local_bash', description: '' }))
    });
    return {
        consume(value: unknown, emit = true): void {
            if (ended) return;
            const event = record(value);
            if (event?.type !== 'user') return;
            let changed = false;
            const id = record(event.toolUseResult)?.backgroundTaskId;
            if (typeof id === 'string' && id.trim() && !running.has(id)) {
                running.add(id);
                changed = true;
            }
            const content = record(event.message)?.content;
            const texts = typeof content === 'string' ? [content]
                : Array.isArray(content) ? content.flatMap(block => {
                    const item = record(block);
                    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
                }) : [];
            for (const text of texts) {
                // Only native notification bodies, never quoted prose or tool output.
                if (!/^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(text)) continue;
                const taskId = /<task-id>\s*([^<]+?)\s*<\/task-id>/.exec(text)?.[1];
                const status = /<status>\s*([^<]+?)\s*<\/status>/.exec(text)?.[1];
                if (taskId && status && ['completed', 'failed', 'killed', 'cancelled'].includes(status)) {
                    changed = running.delete(taskId) || changed;
                }
            }
            if (changed && emit) publish();
        },
        publish,
        end(): void {
            if (ended) return;
            ended = true;
            running.clear();
            publish();
        }
    };
}

// The hook receiver and launcher share the same Session object. Weak ownership
// avoids a stale launcher clearing the next launcher's state after a mode switch.
const owners = new WeakMap<object, () => void>();
export function bindLocalBackgroundTasks(owner: object, end: () => void): () => void {
    owners.set(owner, end);
    return () => { if (owners.get(owner) === end) owners.delete(owner); };
}
export function endLocalBackgroundTasks(owner: object): void { owners.get(owner)?.(); }
