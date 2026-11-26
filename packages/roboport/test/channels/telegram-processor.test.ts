import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
  type Mock,
} from 'bun:test';

import {
  createTelegramUpdateProcessor,
  memoryStore,
  type ConversationStore,
  type TelegramInboundMessage,
} from '@/channels';
import {
  Agent,
  Model,
  type Message,
  type ModelStreamEvent,
  type SearchHit,
} from '@/core';
import {
  TelegramClient,
  type TelegramMessage,
  type TelegramUpdate,
} from '@/triggers/sources/telegram';

const config = { token: 'test-token' };

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: -42, type: 'supergroup' },
    message_thread_id: 9,
    date: 0,
    text: 'hello',
    ...overrides,
  };
}

function update(
  id: number,
  overrides: Partial<TelegramMessage> = {},
): TelegramUpdate {
  return { update_id: id, message: message({ message_id: id, ...overrides }) };
}

class StubModel extends Model {
  readonly turns: Message[][] = [];

  async *streamMessage({
    messages,
  }: Parameters<Model['streamMessage']>[0]): AsyncIterable<ModelStreamEvent> {
    this.turns.push([...messages]);
    yield { type: 'text-delta', text: 'answer' };
    yield { type: 'text-end', text: 'answer' };
    yield {
      type: 'message-end',
      id: 'stub',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async searchWeb(): Promise<SearchHit[]> {
    return [];
  }
}

function stubAgent(model = new StubModel()): Agent {
  return new Agent({ model, system: 'test', tools: [], skills: [] });
}

function mockTelegram(): {
  send: Mock<TelegramClient['sendRichMessage']>;
  draft: Mock<TelegramClient['sendRichMessageDraft']>;
  typing: Mock<TelegramClient['sendChatAction']>;
  fetch: Mock<typeof fetch>;
} {
  return {
    send: spyOn(TelegramClient.prototype, 'sendRichMessage').mockResolvedValue(
      message(),
    ),
    draft: spyOn(
      TelegramClient.prototype,
      'sendRichMessageDraft',
    ).mockResolvedValue(true),
    typing: spyOn(TelegramClient.prototype, 'sendChatAction').mockResolvedValue(
      true,
    ),
    fetch: spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('unexpected network call'),
    ),
  };
}

describe('createTelegramUpdateProcessor', () => {
  let telegram: ReturnType<typeof mockTelegram>;

  beforeEach(() => {
    telegram = mockTelegram();
  });

  afterEach(() => {
    try {
      expect(telegram.fetch).not.toHaveBeenCalled();
    } finally {
      for (const spy of Object.values(telegram)) spy.mockRestore();
    }
  });

  test('replays a serialized update on a fresh processor with topic history and inline reply context', async () => {
    const store = memoryStore();
    await createTelegramUpdateProcessor(stubAgent(), config, { store })(
      update(1, { text: 'earlier topic message' }),
    );
    await store.append('-42:10', { role: 'user', content: 'other topic' });

    const serialized = JSON.stringify(
      update(2, {
        text: 'what about this?',
        reply_to_message: message({
          message_id: 17,
          from: {
            id: 7,
            is_bot: true,
            first_name: 'Example',
            username: 'ExampleBot',
          },
          text: 'The limit resets hourly.',
        }),
        quote: { text: 'resets hourly', position: 10 },
      }),
    );
    const model = new StubModel();
    const prompt = mock(
      (inbound: TelegramInboundMessage): string => inbound.text,
    );
    const processUpdate = createTelegramUpdateProcessor(
      stubAgent(model),
      config,
      { store, prompt },
    );
    await processUpdate(JSON.parse(serialized) as TelegramUpdate);

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({
      id: '2',
      conversationId: '-42:9',
      replyTo: {
        id: '17',
        text: 'The limit resets hourly.',
        user: { id: '7', name: 'ExampleBot' },
        isBot: true,
        quote: 'resets hourly',
      },
    });
    expect(telegram.send).toHaveBeenCalledTimes(2);
    expect(telegram.send).toHaveBeenLastCalledWith(
      -42,
      { markdown: 'answer' },
      expect.objectContaining({ messageThreadId: 9 }),
    );

    const earlier: Message = { role: 'user', content: 'earlier topic message' };
    const current: Message = { role: 'user', content: 'what about this?' };
    const answer: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
    };
    expect(model.turns).toHaveLength(1);
    expect(model.turns[0]?.filter(({ role }) => role !== 'system')).toEqual([
      earlier,
      answer,
      current,
    ]);
    expect(await store.load('-42:9')).toEqual([
      earlier,
      answer,
      current,
      answer,
    ]);
    expect(await store.load('-42:10')).toEqual([
      { role: 'user', content: 'other topic' },
    ]);
  });

  test('still observes a model failure when the relay does not read the stream', async () => {
    const model = new StubModel();
    const failure = new Error('model unavailable');
    spyOn(model, 'streamMessage').mockImplementation(async function* () {
      yield { type: 'text-delta', text: 'partial' };
      throw failure;
    });
    const processUpdate = createTelegramUpdateProcessor(
      stubAgent(model),
      config,
      {
        relay: async () => {},
      },
    );
    await expect(processUpdate(update(1))).rejects.toThrow('model unavailable');
  });

  test('does not complete while the final history append is pending', async () => {
    const history = memoryStore();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const store: ConversationStore = {
      load: history.load,
      async append(id, ...messages): Promise<void> {
        if (messages.some(({ role }) => role === 'assistant')) {
          entered.resolve();
          await release.promise;
        }
        await history.append(id, ...messages);
      },
    };
    const processUpdate = createTelegramUpdateProcessor(stubAgent(), config, {
      store,
    });
    const completion = processUpdate(update(1));
    try {
      // Advance to the next event-loop turn so a premature resolution is observable.
      const checkpoint = entered.promise.then(
        () =>
          new Promise<string>((resolve) => {
            setImmediate(() => resolve('append pending'));
          }),
      );
      expect(
        await Promise.race([checkpoint, completion.then(() => 'completed')]),
      ).toBe('append pending');
      expect(await history.load('-42:9')).toEqual([
        { role: 'user', content: 'hello' },
      ]);
    } finally {
      release.resolve();
      await completion;
    }
    expect((await history.load('-42:9'))?.map(({ role }) => role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  test('rejects a send failure without poisoning an already queued update for the same topic', async () => {
    const failure = new Error('Telegram send failed');
    telegram.send.mockRejectedValueOnce(failure);
    const store = memoryStore();
    const processUpdate = createTelegramUpdateProcessor(stubAgent(), config, {
      store,
    });
    const first = processUpdate(update(1));
    const second = processUpdate(update(2, { text: 'next message' }));
    const results = await Promise.allSettled([first, second]);

    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'fulfilled', value: undefined },
    ]);
    expect((await store.load('-42:9'))?.slice(-2)).toEqual([
      { role: 'user', content: 'next message' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ]);
  });

  test('calls onError but still rejects a failed final append', async () => {
    const failure = new Error('history write failed');
    const history = memoryStore();
    const store: ConversationStore = {
      load: history.load,
      async append(id, ...messages): Promise<void> {
        if (messages.some(({ role }) => role === 'assistant')) throw failure;
        await history.append(id, ...messages);
      },
    };
    const onError = mock((): void => {});
    const processUpdate = createTelegramUpdateProcessor(stubAgent(), config, {
      store,
      onError,
    });

    await expect(processUpdate(update(1))).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ conversationId: '-42:9' }),
      expect.objectContaining({ id: '1' }),
    );
  });

  test('ignores unsupported update kinds and commands not addressed to this bot', async () => {
    const model = new StubModel();
    const store = memoryStore();
    const processUpdate = createTelegramUpdateProcessor(
      stubAgent(model),
      {
        ...config,
        commands: ['/ask'],
        botUsername: 'ExampleBot',
      },
      { store },
    );

    await processUpdate({ update_id: 1 });
    await processUpdate({
      update_id: 2,
      edited_message: message({ text: '/ask' }),
    });
    await processUpdate(update(3, { text: '/ask@OtherBot' }));
    await processUpdate(update(4, { text: '/start' }));
    await processUpdate(update(5, { text: 'plain text' }));
    expect(model.turns).toEqual([]);
    expect(await store.load('-42:9')).toBeNull();
    expect(telegram.send).not.toHaveBeenCalled();
    expect(telegram.draft).not.toHaveBeenCalled();
    expect(telegram.typing).not.toHaveBeenCalled();

    await processUpdate(update(6, { text: '/ask@examplebot a question' }));
    expect(model.turns).toHaveLength(1);
    expect(telegram.send).toHaveBeenCalledTimes(1);
  });
});
