import { describe, expect, it, vi } from 'vitest';
import { runTasks } from '../../src/runner/pool.ts';
import { outcome, type Task, type TaskRecord } from '../../src/runner/task.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function task(id: string, body: Task['run']): Task {
  return { id, title: id, run: body };
}

describe('runTasks', () => {
  it('runs every task and classifies the results', async () => {
    const result = await runTasks([
      task('a', async () => outcome.success('ok')),
      task('b', async () => outcome.skipped('nah')),
      task('c', async () => outcome.failure('boom')),
    ]);

    expect(result.succeeded.map((r) => r.id)).toEqual(['a']);
    expect(result.skipped.map((r) => r.id)).toEqual(['b']);
    expect(result.failed.map((r) => r.id)).toEqual(['c']);
  });

  it('preserves input order in the records', async () => {
    const result = await runTasks(
      ['a', 'b', 'c'].map((id) =>
        task(id, async () => {
          await delay(id === 'a' ? 20 : 1);
          return outcome.success();
        }),
      ),
    );
    expect(result.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('records a thrown error as a failure rather than rejecting', async () => {
    const result = await runTasks([
      task('boom', async () => {
        throw new Error('kaboom');
      }),
      task('fine', async () => outcome.success()),
    ]);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error?.message).toBe('kaboom');
    expect(result.succeeded.map((r) => r.id)).toEqual(['fine']);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;

    await runTasks(
      Array.from({ length: 12 }, (_, index) =>
        task(String(index), async () => {
          active += 1;
          peak = Math.max(peak, active);
          await delay(5);
          active -= 1;
          return outcome.success();
        }),
      ),
      { concurrency: 3 },
    );

    expect(peak).toBe(3);
  });

  it('runs everything at once when unlimited', async () => {
    let active = 0;
    let peak = 0;

    await runTasks(
      Array.from({ length: 8 }, (_, index) =>
        task(String(index), async () => {
          active += 1;
          peak = Math.max(peak, active);
          await delay(5);
          active -= 1;
          return outcome.success();
        }),
      ),
      { concurrency: Number.POSITIVE_INFINITY },
    );

    expect(peak).toBe(8);
  });

  it('treats a concurrency of 0 as unlimited', async () => {
    let peak = 0;
    let active = 0;

    await runTasks(
      Array.from({ length: 5 }, (_, index) =>
        task(String(index), async () => {
          active += 1;
          peak = Math.max(peak, active);
          await delay(2);
          active -= 1;
          return outcome.success();
        }),
      ),
      { concurrency: 0 },
    );

    expect(peak).toBe(5);
  });

  it('captures logged output in order', async () => {
    const result = await runTasks([
      task('a', async (context) => {
        context.log('first');
        context.echo('git', ['status']);
        context.log('last');
        return outcome.success();
      }),
    ]);

    expect(result.records[0]?.lines).toEqual(['first', '+ git status', 'last']);
  });

  it('retains only the most recent lines', async () => {
    const result = await runTasks(
      [
        task('a', async (context) => {
          for (let index = 0; index < 10; index += 1) context.log(`line ${index}`);
          return outcome.success();
        }),
      ],
      { maxLines: 3 },
    );

    expect(result.records[0]?.lines).toEqual(['line 7', 'line 8', 'line 9']);
  });

  it('reports lifecycle callbacks', async () => {
    const started: string[] = [];
    const completed: string[] = [];

    await runTasks([task('a', async () => outcome.success())], {
      onStart: (record: TaskRecord) => started.push(record.id),
      onComplete: (record: TaskRecord) => completed.push(record.id),
    });

    expect(started).toEqual(['a']);
    expect(completed).toEqual(['a']);
  });

  it('times each task', async () => {
    const result = await runTasks([
      task('a', async () => {
        await delay(10);
        return outcome.success();
      }),
    ]);

    const record = result.records[0]!;
    expect(record.startedAt).toBeDefined();
    expect(record.endedAt).toBeGreaterThanOrEqual(record.startedAt!);
  });

  it('skips remaining tasks once aborted', async () => {
    const controller = new AbortController();
    const run = vi.fn<Task['run']>(async () => outcome.success());

    controller.abort();
    const result = await runTasks([task('a', run), task('b', run)], {
      signal: controller.signal,
      concurrency: 1,
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]?.summary).toBe('cancelled');
  });

  it('handles an empty task list', async () => {
    const result = await runTasks([]);
    expect(result.records).toEqual([]);
  });

  it('exposes task data for aggregation', async () => {
    const result = await runTasks([
      task('a', async () => outcome.success('done', { installed: true })),
    ]);
    expect(result.records[0]?.data).toEqual({ installed: true });
  });

  it('clears the transient status once a task finishes', async () => {
    const result = await runTasks([
      task('a', async (context) => {
        context.setStatus('working');
        return outcome.success();
      }),
    ]);
    expect(result.records[0]?.status).toBeUndefined();
  });
});
