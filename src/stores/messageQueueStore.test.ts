/**
 * Message Queue Store Tests
 */

import { useMessageQueueStore } from './messageQueueStore';

beforeEach(() => {
  useMessageQueueStore.setState({ queue: [] });
});

describe('messageQueueStore', () => {
  it('should enqueue messages', () => {
    const store = useMessageQueueStore.getState();
    const id = store.enqueue('Hello');
    expect(id).toBeTruthy();
    expect(store.size()).toBe(1);
  });

  it('should dequeue in FIFO order', () => {
    const store = useMessageQueueStore.getState();
    store.enqueue('First');
    store.enqueue('Second');

    const first = useMessageQueueStore.getState().dequeue();
    expect(first?.content).toBe('First');

    const second = useMessageQueueStore.getState().dequeue();
    expect(second?.content).toBe('Second');

    const empty = useMessageQueueStore.getState().dequeue();
    expect(empty).toBeNull();
  });

  it('should peek without removing', () => {
    const store = useMessageQueueStore.getState();
    store.enqueue('Hello');

    const peeked = useMessageQueueStore.getState().peek();
    expect(peeked?.content).toBe('Hello');
    expect(useMessageQueueStore.getState().size()).toBe(1);
  });

  it('should return null from peek when empty', () => {
    expect(useMessageQueueStore.getState().peek()).toBeNull();
  });

  it('should clear all messages', () => {
    const store = useMessageQueueStore.getState();
    store.enqueue('One');
    store.enqueue('Two');
    useMessageQueueStore.getState().clear();
    expect(useMessageQueueStore.getState().size()).toBe(0);
  });

  it('should return correct size', () => {
    const store = useMessageQueueStore.getState();
    expect(store.size()).toBe(0);
    store.enqueue('A');
    expect(useMessageQueueStore.getState().size()).toBe(1);
    useMessageQueueStore.getState().enqueue('B');
    expect(useMessageQueueStore.getState().size()).toBe(2);
  });
});
