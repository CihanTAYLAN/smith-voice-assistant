import { describe, expect, it } from 'vitest';

import {
  createSystemScope,
  createWorkspaceScope,
  ForbiddenError,
  InvalidScopeError,
  requireRole,
  rlsPolicyFor,
  scopeFilter,
} from './index.js';

const VALID_WS = 'ws_abcdefghij0123456789';
const VALID_ACTOR = 'act_abcdefghij0123456789';

describe('workspace scope', () => {
  it('bicimsiz workspace id reddedilir', () => {
    expect(() =>
      createWorkspaceScope({ workspaceId: 'tenant-1', actorId: VALID_ACTOR, role: 'owner' }),
    ).toThrow(InvalidScopeError);
  });

  it('kapsam filtresi workspace id tasir', () => {
    const scope = createWorkspaceScope({
      workspaceId: VALID_WS,
      actorId: VALID_ACTOR,
      role: 'member',
    });
    expect(scopeFilter(scope)).toEqual({ workspaceId: VALID_WS });
  });

  it('sistem kapsami gerekce olmadan uretilemez', () => {
    expect(() => createSystemScope('kisa')).toThrow(InvalidScopeError);
    expect(createSystemScope('nightly memory compaction').system).toBe(true);
  });

  it('sistem kapsaminda filtre bostur', () => {
    expect(scopeFilter(createSystemScope('nightly memory compaction'))).toEqual({});
  });

  it('rol hiyerarsisi zorlanir', () => {
    const viewer = createWorkspaceScope({
      workspaceId: VALID_WS,
      actorId: VALID_ACTOR,
      role: 'viewer',
    });
    expect(() => requireRole(viewer, 'admin')).toThrow(ForbiddenError);
    expect(() => requireRole(viewer, 'viewer')).not.toThrow();
  });

  it('RLS politikasi hem USING hem WITH CHECK uretir', () => {
    const sql = rlsPolicyFor('memory');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('USING');
    expect(sql).toContain('WITH CHECK');
  });
});
