import { Schema, model, Document } from 'mongoose';

export type DLQStatus = 'pending' | 'replaying' | 'replayed' | 'exhausted';

export interface IDLQDocument extends Document {
  jobId: string;
  idempotencyKey: string;
  targetUrl: string;
  payload: Record<string, unknown>;
  attemptsMade: number;
  lastError: {
    message: string;
    code?: string;
    stack?: string;
    timestamp: Date;
  };
  status: DLQStatus;
  replayedAt?: Date;
  replayedJobId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const dlqSchema = new Schema<IDLQDocument>(
  {
    jobId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    idempotencyKey: {
      type: String,
      required: true,
      index: true,
    },
    targetUrl: {
      type: String,
      required: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    attemptsMade: {
      type: Number,
      required: true,
      default: 0,
    },
    lastError: {
      message: { type: String, required: true },
      code: { type: String },
      stack: { type: String },
      timestamp: { type: Date, default: Date.now },
    },
    status: {
      type: String,
      enum: ['pending', 'replaying', 'replayed', 'exhausted'],
      default: 'pending',
      index: true,
    },
    replayedAt: {
      type: Date,
    },
    replayedJobId: {
      type: String,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Compound index for querying pending/exhausted failures in chronological order
dlqSchema.index({ status: 1, createdAt: -1 });

export const DLQModel = model<IDLQDocument>('DeadLetterQueue', dlqSchema);

export default DLQModel;
