import assert from 'node:assert/strict';
import { isAbsolute, join, resolve } from 'node:path';

/** Only the verifier's exact, uniquely marked child cluster may be removed. */
export function validateOwnedWindowsCluster(evidenceRoot, directory, cluster, marker, runId) {
  assert.match(runId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert(isAbsolute(evidenceRoot) && isAbsolute(directory) && isAbsolute(cluster));
  assert.equal(directory, resolve(evidenceRoot, runId), 'Unowned verifier directory.');
  assert.equal(cluster, join(directory, 'cluster'), 'Cluster escaped its owned directory.');
  assert.equal(marker?.runId, runId, 'Cluster marker belongs to a different run.');
  assert.equal(marker?.cluster, cluster, 'Cluster marker target differs.');
}
