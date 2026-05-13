import { Injectable } from '@nestjs/common';

/**
 * Immutable snapshot store. Each accepted patch creates a new snapshot;
 * `accept` simply moves Workspace.headSnapshotId — never mutates past snapshots.
 * Backed by S3 / MinIO (filesRef = bucket key).
 */
@Injectable()
export class SnapshotService {
  // TODO: createFromPatch / read / list / setHead
}
