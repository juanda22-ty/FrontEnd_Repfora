import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  sender: { type: String },
  subject: { type: String, required: true },
  fiche: { type: String },
  recipient: { type: String, required: true },
  read: { type: Boolean, default: false },
  date: { type: Date, default: Date.now }
}, { timestamps: true });

const Notification = mongoose.model('Notification', notificationSchema, 'notifications');

export default Notification;
