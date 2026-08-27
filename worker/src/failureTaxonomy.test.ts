import { describe, expect, it } from 'vitest';
import { classifyFailureCategory, isRetryableCategory } from './failureTaxonomy';

describe('classifyFailureCategory', () => {
  it('defaults to CODE_FAILURE with no other signal', () => {
    expect(classifyFailureCategory({})).toBe('CODE_FAILURE');
  });

  it('maps CI classifications onto the taxonomy', () => {
    expect(classifyFailureCategory({ ciClassification: 'HUMAN_REQUIRED' })).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(classifyFailureCategory({ ciClassification: 'CI_TRANSIENT' })).toBe('TRANSIENT_FAILURE');
    expect(classifyFailureCategory({ ciClassification: 'CI_CONFIG_FAILURE' })).toBe('CI_CONFIG_FAILURE');
    expect(classifyFailureCategory({ ciClassification: 'CI_CODE_FAILURE' })).toBe('CODE_FAILURE');
  });

  it('prefers a known declared category over the generic CI classification', () => {
    expect(classifyFailureCategory({
      ciClassification: 'CI_CODE_FAILURE',
      declaredCategories: ['GUARD_FAILURE'],
    })).toBe('GUARD_FAILURE');
  });

  it('ignores an unrecognized declared category and falls back to CI classification', () => {
    expect(classifyFailureCategory({
      ciClassification: 'CI_CODE_FAILURE',
      declaredCategories: ['SOMETHING_A_REPO_AUTHOR_MADE_UP'],
    })).toBe('CODE_FAILURE');
  });

  it('picks the first known declared category, deterministically, when several are present', () => {
    expect(classifyFailureCategory({
      declaredCategories: ['UNKNOWN_ONE', 'POLICY_FAILURE', 'ENV_FAILURE'],
    })).toBe('POLICY_FAILURE');
  });

  it('rate limiting takes priority over any CI classification', () => {
    expect(classifyFailureCategory({ ciClassification: 'CI_CODE_FAILURE', rateLimited: true })).toBe('RATE_LIMITED');
  });

  it('context pressure takes priority over everything else', () => {
    expect(classifyFailureCategory({
      ciClassification: 'HUMAN_REQUIRED',
      rateLimited: true,
      contextPressure: true,
    })).toBe('CONTEXT_PRESSURE');
  });
});

describe('isRetryableCategory', () => {
  it('is false for human-gated and rate-limited categories', () => {
    expect(isRetryableCategory('HUMAN_APPROVAL_REQUIRED')).toBe(false);
    expect(isRetryableCategory('RATE_LIMITED')).toBe(false);
  });

  it('is true for ordinary code-side failures', () => {
    expect(isRetryableCategory('CODE_FAILURE')).toBe(true);
    expect(isRetryableCategory('TRANSIENT_FAILURE')).toBe(true);
  });
});
