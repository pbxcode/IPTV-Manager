import express from 'express';
import * as playlistController from '../controllers/playlistController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

router.get('/playlists', authenticateToken, playlistController.listPlaylists);
router.get('/playlists/by-zip/:zip', authenticateToken, playlistController.findByZip);
router.get('/playlists/:id', authenticateToken, playlistController.getPlaylist);
router.post('/playlists', authenticateToken, playlistController.createPlaylist);
router.put('/playlists/:id', authenticateToken, playlistController.updatePlaylist);
router.delete('/playlists/:id', authenticateToken, playlistController.deletePlaylist);

router.put('/playlists/:id/zip-codes', authenticateToken, playlistController.setZipCodes);
router.post('/playlists/:id/channels', authenticateToken, playlistController.addChannels);
router.post('/playlists/:id/category', authenticateToken, playlistController.addCategory);
router.delete('/playlists/:id/channels', authenticateToken, playlistController.removeChannels);

router.post('/playlists/:id/assign', authenticateToken, playlistController.assignToUser);
router.delete('/playlists/:id/assign', authenticateToken, playlistController.unassignFromUser);

export default router;
