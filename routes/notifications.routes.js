import express from 'express';
import jwt from 'jsonwebtoken';
import Notification from '../models/Notification.js';

const router = express.Router();

const getUserEmailFromToken = (req) => {
  try {
    const token = req.headers.token || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithm: 'HS256' });
    return decoded.email || null;
  } catch {
    return null;
  }
};

// Ruta para obtener las notificaciones del usuario autenticado
router.get('/', async (req, res) => {
  try {
    const email = getUserEmailFromToken(req);
    if (!email) return res.json([]);

    const notifications = await Notification.find({ recipient: email })
      .sort({ date: -1 })
      .limit(100);

    res.json(notifications);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener notificaciones', error: error.message });
  }
});

// Ruta para marcar una notificación como leída
router.put('/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      { $set: { read: true } },
      { new: true }
    );

    if (!notification) return res.status(404).json({ message: 'Notificación no encontrada' });

    res.json({ message: 'Notificación marcada como leída', data: notification });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar notificación', error: error.message });
  }
});

export { router as routerNotifications };
