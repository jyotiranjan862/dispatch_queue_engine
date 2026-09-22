import { Schema, model, Document, Types } from 'mongoose';

export type DLQStatus = 'pending' | 'replaying' | 'replayed' | 'exhausted';

export interface IDLQDocument extends Document {
  projectId: Types.ObjectId;
  projectSlug: string;
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
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    projectSlug: {
      type: String,
      required: true,
      index: true,
    },
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

// Compound indexes for project segregation and fast dashboard querying
dlqSchema.index({ projectId: 1, status: 1, createdAt: -1 });
dlqSchema.index({ projectSlug: 1, createdAt: -1 });

export const DLQModel = model<IDLQDocument>('DeadLetterQueue', dlqSchema);

export default DLQModel;
