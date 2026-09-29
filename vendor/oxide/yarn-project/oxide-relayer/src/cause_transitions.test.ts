import { describe, expect, it } from '@jest/globals';

import { CauseTransitions } from './cause_transitions.js';

describe('CauseTransitions', () => {
  it('reports the first cause for a key', () => {
    const transitions = new CauseTransitions();
    expect(transitions.changed('a', 'unprofitable')).toBe(true);
  });

  it('stays quiet while the cause holds', () => {
    const transitions = new CauseTransitions();
    transitions.changed('a', 'unprofitable');
    expect(transitions.changed('a', 'unprofitable')).toBe(false);
    expect(transitions.changed('a', 'unprofitable')).toBe(false);
  });

  it('reports a new cause for the same key', () => {
    const transitions = new CauseTransitions();
    transitions.changed('a', 'unprofitable');
    expect(transitions.changed('a', 'pool_out_of_scope')).toBe(true);
    expect(transitions.changed('a', 'pool_out_of_scope')).toBe(false);
  });

  it('keeps one key clear of another', () => {
    const transitions = new CauseTransitions();
    transitions.changed('a', 'unprofitable');
    expect(transitions.changed('b', 'unprofitable')).toBe(true);
  });

  it('reports again after the key is forgotten', () => {
    const transitions = new CauseTransitions();
    transitions.changed('a', 'unprofitable');
    transitions.forget('a');
    expect(transitions.changed('a', 'unprofitable')).toBe(true);
  });

  it('forgets every key under one prefix', () => {
    const transitions = new CauseTransitions();
    transitions.changed('sipa:tokenA', 'unprofitable');
    transitions.changed('sipa:tokenB', 'unprofitable');
    transitions.changed('other:tokenA', 'unprofitable');
    transitions.forgetPrefix('sipa:');
    expect(transitions.changed('sipa:tokenA', 'unprofitable')).toBe(true);
    expect(transitions.changed('sipa:tokenB', 'unprofitable')).toBe(true);
    expect(transitions.changed('other:tokenA', 'unprofitable')).toBe(false);
  });

  it('leaves other keys alone when it forgets one', () => {
    const transitions = new CauseTransitions();
    transitions.changed('a', 'unprofitable');
    transitions.changed('b', 'unprofitable');
    transitions.forget('a');
    expect(transitions.changed('b', 'unprofitable')).toBe(false);
  });
});
