import { mergeAssignmentCandidates, rebindSeriesEpisodeAliases } from '../services/userChannelAssignmentService.js';

export function migrateUserChannelMappingId(db) {
  try {
    const columns = db.prepare('PRAGMA table_info(user_channels)').all().map(column => column.name);
    if (!columns.includes('mapping_id')) {
      db.exec('ALTER TABLE user_channels ADD COLUMN mapping_id INTEGER');
      console.log('✅ DB Migration: mapping_id column added to user_channels');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_channels_mapping ON user_channels(mapping_id)');
  } catch (e) {
    console.error('User channel mapping migration error:', e);
  }
}

export function migrateUserChannelAssignmentOrigin(db) {
  try {
    const columns = db.prepare('PRAGMA table_info(user_channels)').all().map(column => column.name);
    if (!columns.includes('assignment_origin')) {
      db.exec(`
        ALTER TABLE user_channels
        ADD COLUMN assignment_origin TEXT NOT NULL DEFAULT 'legacy'
          CHECK (assignment_origin IN ('legacy', 'manual', 'mapping', 'imported'))
      `);
      console.log('✅ DB Migration: assignment_origin column added to user_channels');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_channels_origin_mapping
      ON user_channels(assignment_origin, mapping_id)
    `);
  } catch (e) {
    console.error('User channel assignment origin migration error:', e);
    throw e;
  }
}

export function migrateUserChannelMappingBackfillV1(db) {
  const markerKey = 'user_channel_mapping_backfill_v1';
  const migrate = db.transaction(() => {
    if (db.prepare('SELECT value FROM settings WHERE key = ?').get(markerKey)?.value) {
      return { assigned: 0, ambiguous: 0, unmatched: 0, skipped: true };
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      markerKey,
      JSON.stringify({ assigned: 0, ambiguous: 0, unmatched: 0, mode: 'marker-only' })
    );
    console.info('✅ Mapping backfill V1 recorded without inferring assignment ownership');
    return { assigned: 0, ambiguous: 0, unmatched: 0, skipped: false };
  });

  return migrate();
}

export function migrateUserChannelAssignmentProvenanceV2(db) {
  const markerKey = 'user_channel_assignment_provenance_v2';
  const migrate = db.transaction(() => {
    const marker = db.prepare('SELECT value FROM settings WHERE key = ?').get(markerKey);
    if (marker?.value) return { repaired: 0, skipped: true };

    const repaired = db.prepare(`
      UPDATE user_channels
      SET assignment_origin = 'legacy', mapping_id = NULL
      WHERE assignment_origin != 'legacy' OR mapping_id IS NOT NULL
    `).run().changes;
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      markerKey,
      JSON.stringify({ repaired, mode: 'fail-safe-legacy' })
    );
    console.info(`✅ Assignment provenance V2: ${repaired} uncertain row(s) reset to legacy`);
    return { repaired, skipped: false };
  });

  return migrate();
}

export function migrateUserChannelDeduplicationV1(db) {
  const markerKey = 'user_channel_deduplication_v1';
  const migrate = db.transaction(() => {
    const marker = db.prepare('SELECT value FROM settings WHERE key = ?').get(markerKey);
    if (marker?.value) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_user_channels_category_provider
          ON user_channels(user_category_id, provider_channel_id);
      `);
      return { merged: 0, skipped: true };
    }

    const aliasTable = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'series_episode_aliases'
    `).get();
    const hasOrigin = db.prepare('PRAGMA table_info(user_channels)').all()
      .some(column => column.name === 'assignment_origin');
    const duplicateGroups = db.prepare(`
      SELECT user_category_id, provider_channel_id
      FROM user_channels
      GROUP BY user_category_id, provider_channel_id
      HAVING COUNT(*) > 1
      ORDER BY user_category_id, provider_channel_id
    `).all();

    const selectRows = db.prepare(`
      SELECT id, user_category_id, provider_channel_id, sort_order, custom_name,
             is_hidden, mapping_id, granted_by_admin, authorization_revoked
             ${hasOrigin ? ', assignment_origin' : ''}
      FROM user_channels
      WHERE user_category_id = ? AND provider_channel_id = ?
      ORDER BY id
    `);
    const updateSurvivor = db.prepare(`
      UPDATE user_channels
      SET is_hidden = ?,
          custom_name = ?,
          granted_by_admin = ?,
          authorization_revoked = ?,
          sort_order = ?${hasOrigin ? ', assignment_origin = ?, mapping_id = ?' : ', mapping_id = NULL'}
      WHERE id = ?
    `);
    const deleteAssignment = db.prepare('DELETE FROM user_channels WHERE id = ?');
    let mergedCount = 0;

    for (const group of duplicateGroups) {
      const rows = selectRows.all(group.user_category_id, group.provider_channel_id);
      const normalized = rows.map(row => ({
        ...row,
        assignment_origin: hasOrigin ? row.assignment_origin : 'legacy'
      }));
      const mergedRow = mergeAssignmentCandidates(normalized);
      const survivor = normalized.find(row => Number(row.id) === Number(mergedRow.id)) || normalized[0];
      const losers = normalized.filter(row => Number(row.id) !== Number(survivor.id));

      updateSurvivor.run(
        mergedRow.is_hidden,
        mergedRow.custom_name || '',
        mergedRow.granted_by_admin,
        mergedRow.authorization_revoked,
        mergedRow.sort_order,
        ...(hasOrigin ? [mergedRow.assignment_origin, mergedRow.mapping_id] : []),
        survivor.id
      );
      for (const loser of losers) {
        if (aliasTable) rebindSeriesEpisodeAliases(db, survivor.id, loser.id);
        deleteAssignment.run(loser.id);
        mergedCount++;
      }
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_user_channels_category_provider
        ON user_channels(user_category_id, provider_channel_id);
    `);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      markerKey,
      JSON.stringify({ merged: mergedCount })
    );
    console.info(`✅ User channel deduplication: ${mergedCount} duplicate assignment(s) merged`);
    return { merged: mergedCount, skipped: false };
  });

  return migrate();
}

export function migrateUserChannelAdminGrants(db) {
  const migrate = db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(user_channels)').all().map(column => column.name);
    const markerKey = 'user_channel_authorization_v1';
    const completed = db.prepare('SELECT value FROM settings WHERE key = ?').get(markerKey);
    const authorizationView = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'view' AND name = 'authorized_user_channels'
    `).get();
    if (completed?.value === 'true' && authorizationView &&
        columns.includes('granted_by_admin') && columns.includes('authorization_revoked')) {
      return 0;
    }

    if (!columns.includes('granted_by_admin')) {
      db.exec('ALTER TABLE user_channels ADD COLUMN granted_by_admin INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.includes('authorization_revoked')) {
      db.exec('ALTER TABLE user_channels ADD COLUMN authorization_revoked INTEGER NOT NULL DEFAULT 0');
    }

    db.prepare(`
      UPDATE user_channels
      SET granted_by_admin = 0,
          authorization_revoked = 0
      WHERE (granted_by_admin != 0 OR authorization_revoked != 0)
        AND EXISTS (
        SELECT 1
        FROM user_categories cat
        JOIN provider_channels pc ON pc.id = user_channels.provider_channel_id
        JOIN providers p ON p.id = pc.provider_id
        WHERE cat.id = user_channels.user_category_id
          AND p.user_id = cat.user_id
      )
    `).run();

    db.prepare(`
      UPDATE user_channels
      SET authorization_revoked = 0
      WHERE granted_by_admin = 1
        AND authorization_revoked != 0
    `).run();

    const revoked = db.prepare(`
      UPDATE user_channels
      SET authorization_revoked = 1
      WHERE authorization_revoked = 0
        AND granted_by_admin = 0
        AND NOT EXISTS (
          SELECT 1
          FROM user_categories cat
          JOIN provider_channels pc ON pc.id = user_channels.provider_channel_id
          JOIN providers p ON p.id = pc.provider_id
          WHERE cat.id = user_channels.user_category_id
            AND p.user_id = cat.user_id
        )
    `).run().changes;

    db.exec(`
      DROP VIEW IF EXISTS authorized_user_channels;
      CREATE VIEW authorized_user_channels AS
      SELECT uc.*
      FROM user_channels uc
      JOIN user_categories cat ON cat.id = uc.user_category_id
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN providers p ON p.id = pc.provider_id
      WHERE uc.is_hidden = 0
        AND uc.authorization_revoked = 0
        AND (p.user_id = cat.user_id OR uc.granted_by_admin = 1)
    `);

    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, 'true')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(markerKey);

    return revoked;
  });

  try {
    const revoked = migrate();
    console.info(`✅ DB Migration: user channel authorization ready; revoked ${revoked} unauthorized assignment(s)`);
    return revoked;
  } catch (e) {
    console.error('User channel admin grants migration error:', e.message);
    throw e;
  }
}

export function migrateSyncConfigAdminGrants(db) {
  const migrate = db.transaction(() => {
    const columns = db.prepare('PRAGMA table_info(sync_configs)').all().map(column => column.name);
    if (columns.includes('granted_by_admin')) return 0;

    db.exec('ALTER TABLE sync_configs ADD COLUMN granted_by_admin INTEGER NOT NULL DEFAULT 0');
    return db.prepare(`
      UPDATE sync_configs
      SET enabled = 0
      WHERE enabled = 1
        AND NOT EXISTS (
          SELECT 1
          FROM providers p
          WHERE p.id = sync_configs.provider_id
            AND p.user_id IS sync_configs.user_id
        )
    `).run().changes;
  });

  const disabled = migrate();
  if (disabled > 0) {
    console.info(`Sync grant migration disabled ${disabled} unapproved cross-owner config(s)`);
  }
  return disabled;
}

export function migrateUserNotes(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('notes')) {
      db.exec('ALTER TABLE users ADD COLUMN notes TEXT');
      console.log('✅ DB Migration: notes column added to users');
    }
  } catch (e) {
    console.error('User notes migration error:', e);
  }
}

export function migrateProviderUserAssignments(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_user_assignments (
        provider_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        PRIMARY KEY (provider_id, user_id),
        FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pua_user ON provider_user_assignments(user_id);
      CREATE INDEX IF NOT EXISTS idx_pua_provider ON provider_user_assignments(provider_id);
    `);

    // Migrate existing single owners
    const migrated = db.prepare(`
      INSERT OR IGNORE INTO provider_user_assignments (provider_id, user_id)
      SELECT id, user_id FROM providers WHERE user_id IS NOT NULL
    `).run().changes;

    if (migrated > 0) {
      console.log(`✅ DB Migration: migrated ${migrated} provider-user assignments`);
    } else {
      console.log('✅ DB Migration: provider_user_assignments table ready');
    }
  } catch (e) {
    console.error('Provider user assignments migration error:', e);
  }
}

export function migrateAuthorizedChannelsViewForAssignments(db) {
  try {
    db.exec(`
      DROP VIEW IF EXISTS authorized_user_channels;
      CREATE VIEW authorized_user_channels AS
      SELECT uc.*
      FROM user_channels uc
      JOIN user_categories cat ON cat.id = uc.user_category_id
      JOIN provider_channels pc ON pc.id = uc.provider_channel_id
      JOIN providers p ON p.id = pc.provider_id
      WHERE uc.is_hidden = 0
        AND uc.authorization_revoked = 0
        AND (
          uc.granted_by_admin = 1
          OR EXISTS (
            SELECT 1 FROM provider_user_assignments pua
            WHERE pua.provider_id = p.id AND pua.user_id = cat.user_id
          )
          OR p.user_id = cat.user_id
        )
    `);
    console.log('✅ DB Migration: authorized_user_channels view updated for multi-user assignments');
  } catch (e) {
    console.error('Authorized channels view migration error:', e);
  }
}

export function migratePlaylists(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        owner_user_id INTEGER,
        created_by INTEGER,
        is_public INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS playlist_zip_codes (
        playlist_id INTEGER NOT NULL,
        zip_code TEXT NOT NULL,
        PRIMARY KEY (playlist_id, zip_code),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS playlist_channels (
        playlist_id INTEGER NOT NULL,
        provider_channel_id INTEGER NOT NULL,
        sort_order INTEGER DEFAULT 0,
        PRIMARY KEY (playlist_id, provider_channel_id),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (provider_channel_id) REFERENCES provider_channels(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_playlists (
        user_id INTEGER NOT NULL,
        playlist_id INTEGER NOT NULL,
        assigned_at INTEGER DEFAULT (strftime('%s', 'now')),
        PRIMARY KEY (user_id, playlist_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_playlist_zip_code ON playlist_zip_codes(zip_code);
      CREATE INDEX IF NOT EXISTS idx_playlist_channels_playlist ON playlist_channels(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_user_playlists_user ON user_playlists(user_id);
    `);

    // Add zip_code column to users if missing
    const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    if (!userCols.includes('zip_code')) {
      db.exec('ALTER TABLE users ADD COLUMN zip_code TEXT');
      console.log('✅ DB Migration: zip_code column added to users');
    }

    // Add category_label to playlist_channels if missing
    const pcCols = db.prepare("PRAGMA table_info(playlist_channels)").all().map(c => c.name);
    if (!pcCols.includes('category_label')) {
      db.exec('ALTER TABLE playlist_channels ADD COLUMN category_label TEXT');
      console.log('✅ DB Migration: category_label added to playlist_channels');
    }

    console.log('✅ DB Migration: playlists tables ready');
  } catch (e) {
    console.error('Playlists migration error:', e);
  }
}
