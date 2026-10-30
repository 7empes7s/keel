-- Service settings inside the approved setup (baseline). A baseline captured from a
-- backup also holds the Exchange, SharePoint and OneDrive, Teams, Purview and Power
-- Platform settings of the service reads nearest that backup
-- (engine/govern/baselineWorkloads.mjs), one row per setting, the way baseline_resource
-- holds the Microsoft Graph settings. Each row points at the read that holds its
-- approved value. The baseline's observation_scope.workloads names the read each
-- service was captured from. Accepting a service change repoints the active
-- baseline's row; a superseded version keeps its rows as history.
--
-- workload_approved (38-workload-approved.sql) stays the live copy drift compares
-- with: activating a baseline that holds a service puts that service's rows there.
-- Additive and safe to re-apply.
CREATE TABLE IF NOT EXISTS baseline_workload (
  baseline_id   uuid NOT NULL REFERENCES baseline(id) ON DELETE CASCADE,
  workload      text NOT NULL,
  resource_key  text NOT NULL,
  collection_id uuid NOT NULL,
  PRIMARY KEY (baseline_id, workload, resource_key),
  FOREIGN KEY (collection_id, resource_key) REFERENCES workload_observation (collection_id, resource_key)
);
