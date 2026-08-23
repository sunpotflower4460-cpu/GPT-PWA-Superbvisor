import { describe, expect, it } from 'vitest';
import { generateSmartReplies } from './smartReplies';

describe('generateSmartReplies fallback', () => {
  it('returns deterministic ChatGPT suggestions when no provider key exists', async () => {
    const result = await generateSmartReplies({
      project: {
        id: 'p1',
        name: 'Test Project',
        goal: 'Make CI green',
        currentPhase: 'debugging',
        status: 'WAITING_AI',
        automationLevel: 'GUARDIAN',
        definitionOfDone: ['CI passes'],
        humanBlockers: [],
      },
      lastAssistantMessage: 'CI failed.',
    }, {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe('deterministic');
    expect(result.suggestions.length).toBeGreaterThanOrEqual(3);
    for (const suggestion of result.suggestions) {
      expect(suggestion.prompt).toContain('実行主体はこのChatGPT');
      expect(suggestion.prompt).toContain('外部APIはオーケストレーション専用');
    }
  });
});
