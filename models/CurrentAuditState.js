import mongoose from 'mongoose';

const { Schema } = mongoose;

// Aprendiz
const LearnerInfoSchema = new Schema({
  name: String,
  document: String
}, { _id: false });

// Resultado pendiente o vencido
const OutcomeStateSchema = new Schema({
  scheduleId: { type: Schema.Types.ObjectId, ref: 'Schedules' },
  ficheNumber: String,
  ficheId: { type: Schema.Types.ObjectId, ref: 'Fiche' },
  outcomeText: String,
  fend: Date,

  // Para pendientes
  missingLearners: [LearnerInfoSchema],
  totalLearners: Number,
  isTotalMissing: Boolean,

  // Para vencidos
  daysOverdue: Number,
  missingCount: Number,

  // Instructor del schedule
  instructorName: String,
  instructorEmail: String,

  // Líder de la ficha (fiche.owner)
  ficheOwnerName: String,
  ficheOwnerEmail: String,

  // Estado
  isVencido: { type: Boolean, default: false }
}, { _id: false });

// Estado actual de auditoría (registro único)
const CurrentAuditStateSchema = new Schema({
  pendientes: [OutcomeStateSchema],
  vencidos: [OutcomeStateSchema],
  ultimaActualizacion: { type: Date, default: Date.now },
  estadisticas: {
    totalPendientes: { type: Number, default: 0 },
    totalVencidos: { type: Number, default: 0 },
    totalAprendicesSinNota: { type: Number, default: 0 }
  }
}, {
  timestamps: true,
  collection: 'currentauditstate'
});

// Índice único - solo debe existir un registro
CurrentAuditStateSchema.index({}, { unique: true });

export default mongoose.models.CurrentAuditState || mongoose.model('CurrentAuditState', CurrentAuditStateSchema);
