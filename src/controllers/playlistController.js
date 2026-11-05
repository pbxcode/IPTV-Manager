import db from '../database/db.js';
import { immediateTransaction } from '../database/sqliteWrites.js';

function canManagePlaylist(req, playlist) {
  if (req.user.is_admin) return true;
  if (!playlist) return false;
  return Number(playlist.owner_user_id) === Number(req.user.id) || Number(playlist.created_by) === Number(req.user.id);
}

export const listPlaylists = (req, res) => {
  try {
    const { user_id, zip_code } = req.query;
    let query = `
      SELECT p.*, u.username as owner_name,
             (SELECT COUNT(*) FROM playlist_channels pc WHERE pc.playlist_id = p.id) as channel_count,
             (SELECT COUNT(*) FROM playlist_zip_codes pz WHERE pz.playlist_id = p.id) as zip_count
      FROM playlists p
      LEFT JOIN users u ON u.id = p.owner_user_id
    `;
    const params = [];
    const conditions = [];

    if (!req.user.is_admin) {
      conditions.push('(p.is_public = 1 OR p.owner_user_id = ? OR p.created_by = ?)');
      params.push(req.user.id, req.user.id);
    }

    if (user_id) {
      conditions.push('EXISTS (SELECT 1 FROM user_playlists up WHERE up.playlist_id = p.id AND up.user_id = ?)');
      params.push(Number(user_id));
    }

    if (zip_code) {
      conditions.push('EXISTS (SELECT 1 FROM playlist_zip_codes pz WHERE pz.playlist_id = p.id AND pz.zip_code = ?)');
      params.push(String(zip_code).trim());
    }

    if (conditions.length) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY p.name';

    const playlists = db.prepare(query).all(...params);
    res.json(playlists);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const getPlaylist = (req, res) => {
  try {
    const id = Number(req.params.id);
    const playlist = db.prepare(`
      SELECT p.*, u.username as owner_name
      FROM playlists p
      LEFT JOIN users u ON u.id = p.owner_user_id
      WHERE p.id = ?
    `).get(id);

    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    if (!canManagePlaylist(req, playlist) && !playlist.is_public) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const zipCodes = db.prepare('SELECT zip_code FROM playlist_zip_codes WHERE playlist_id = ? ORDER BY zip_code').all(id).map(r => r.zip_code);
    const channels = db.prepare(`
      SELECT pc.provider_channel_id, pc.sort_order, ch.name, ch.stream_type, ch.logo, prov.name as provider_name
      FROM playlist_channels pc
      JOIN provider_channels ch ON ch.id = pc.provider_channel_id
      JOIN providers prov ON prov.id = ch.provider_id
      WHERE pc.playlist_id = ?
      ORDER BY pc.sort_order, ch.name
    `).all(id);

    res.json({ ...playlist, zip_codes: zipCodes, channels });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const createPlaylist = (req, res) => {
  try {
    const { name, description, is_public, owner_user_id } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    // Admins are in admin_users, not users — store null to satisfy the FK
    const ownerId = req.user.is_admin
      ? (owner_user_id ? Number(owner_user_id) : null)
      : req.user.id;
    const createdBy = req.user.is_admin ? null : req.user.id;

    const info = db.prepare(`
      INSERT INTO playlists (name, description, owner_user_id, created_by, is_public)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      name.trim(),
      description?.trim() || null,
      ownerId,
      createdBy,
      is_public ? 1 : 0
    );

    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const updatePlaylist = (req, res) => {
  try {
    const id = Number(req.params.id);
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    if (!canManagePlaylist(req, playlist)) return res.status(403).json({ error: 'Access denied' });

    const { name, description, is_public } = req.body;
    db.prepare(`
      UPDATE playlists
      SET name = ?, description = ?, is_public = ?, updated_at = strftime('%s', 'now')
      WHERE id = ?
    `).run(
      name?.trim() || playlist.name,
      description !== undefined ? (description?.trim() || null) : playlist.description,
      is_public !== undefined ? (is_public ? 1 : 0) : playlist.is_public,
      id
    );

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const deletePlaylist = (req, res) => {
  try {
    const id = Number(req.params.id);
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    if (!canManagePlaylist(req, playlist)) return res.status(403).json({ error: 'Access denied' });

    db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const setZipCodes = (req, res) => {
  try {
    const id = Number(req.params.id);
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    if (!canManagePlaylist(req, playlist)) return res.status(403).json({ error: 'Access denied' });

    const zipCodes = Array.isArray(req.body.zip_codes)
      ? [...new Set(req.body.zip_codes.map(z => String(z).trim()).filter(Boolean))]
      : [];

    immediateTransaction(db, () => {
      db.prepare('DELETE FROM playlist_zip_codes WHERE playlist_id = ?').run(id);
      const insert = db.prepare('INSERT OR IGNORE INTO playlist_zip_codes (playlist_id, zip_code) VALUES (?, ?)');
      for (const zip of zipCodes) insert.run(id, zip);
    });

    res.json({ success: true, count: zipCodes.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const addChannels = (req, res) => {
  try {
    const id = Number(req.params.id);
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    if (!canManagePlaylist(req, playlist)) return res.status(403).json({ error: 'Access denied' });

    const channelIds = Array.isArray(req.body.channel_ids)
      ? req.body.channel_ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
      : [];

    if (!channelIds.length) return res.status(400).json({ error: 'channel_ids required' });

    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM playlist_channels WHERE playlist_id = ?').get(id).m;
    const insert = db.prepare('INSERT OR IGNORE INTO playlist_channels (playlist_id, provider_channel_id, sort_order) VALUES (?, ?, ?)');

    immediateTransaction(db, () => {
      channelIds.forEach((cid, i) => insert.run(id, cid, maxOrder + i + 1));
    });

    res.json({ success: true, added: channelIds.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const removeChannels = (req, res) => {
  try {
    const id = Number(req.params.id);
    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    if (!canManagePlaylist(req, playlist)) return res.status(403).json({ error: 'Access denied' });

    const channelIds = Array.isArray(req.body.channel_ids)
      ? req.body.channel_ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
      : [];

    if (!channelIds.length) return res.status(400).json({ error: 'channel_ids required' });

    const placeholders = channelIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM playlist_channels WHERE playlist_id = ? AND provider_channel_id IN (${placeholders})`).run(id, ...channelIds);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const assignToUser = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Access denied' });

    const playlistId = Number(req.params.id);
    const userId = Number(req.body.user_id);
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    const playlist = db.prepare('SELECT id FROM playlists WHERE id = ?').get(playlistId);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    db.prepare('INSERT OR IGNORE INTO user_playlists (user_id, playlist_id) VALUES (?, ?)').run(userId, playlistId);

    // Optionally copy channels into the user's categories (simple version: just record the assignment)
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const unassignFromUser = (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Access denied' });

    const playlistId = Number(req.params.id);
    const userId = Number(req.body.user_id || req.params.userId);
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    db.prepare('DELETE FROM user_playlists WHERE playlist_id = ? AND user_id = ?').run(playlistId, userId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

export const findByZip = (req, res) => {
  try {
    const zip = String(req.params.zip || req.query.zip || '').trim();
    if (!zip) return res.status(400).json({ error: 'zip required' });

    const playlists = db.prepare(`
      SELECT p.id, p.name, p.description, p.is_public
      FROM playlists p
      JOIN playlist_zip_codes pz ON pz.playlist_id = p.id
      WHERE pz.zip_code = ?
      ORDER BY p.name
    `).all(zip);

    res.json(playlists);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
