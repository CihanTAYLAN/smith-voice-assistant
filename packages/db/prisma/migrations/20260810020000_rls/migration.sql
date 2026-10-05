-- Row Level Security: tenant izolasyonunun ikinci ve son savunma katmani.
--
-- Uygulama rolu (smith_app) superuser/owner DEGILDIR, bu yuzden bu politikalara
-- tabidir. Migration rolu (smith) superuser oldugu icin bypass eder — DDL ve
-- bakim isleri boyle kosar. FORCE, owner'i bile politikaya tabi kilar.
--
-- Oturum degiskeni: smith.workspace_id. Gateway her scoped transaction'da
-- set_config(..., true) ile bunu ayarlar. Set edilmezse current_setting(...,
-- true) NULL doner ve "workspaceId" = NULL hicbir satiri getirmez → fail-closed.

-- Membership
ALTER TABLE "Membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Membership" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Membership_workspace_isolation" ON "Membership";
CREATE POLICY "Membership_workspace_isolation" ON "Membership"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));

-- Session
ALTER TABLE "Session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Session" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Session_workspace_isolation" ON "Session";
CREATE POLICY "Session_workspace_isolation" ON "Session"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));

-- Message
ALTER TABLE "Message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Message_workspace_isolation" ON "Message";
CREATE POLICY "Message_workspace_isolation" ON "Message"
  USING ("workspaceId" = current_setting('smith.workspace_id', true))
  WITH CHECK ("workspaceId" = current_setting('smith.workspace_id', true));
