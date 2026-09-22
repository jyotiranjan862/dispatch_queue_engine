import { Schema, model, Document, Types } from 'mongoose';

export type ProjectStatus = 'active' | 'archived';

export interface IProjectDocument extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  apiKey: string;
  webhookSecret: string;
  description?: string;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProjectDocument>(
  {
    name: {
      type: String,
      required: [true, 'Project name is required'],
      trim: true,
      maxlength: [100, 'Project name cannot exceed 100 characters'],
    },
    slug: {
      type: String,
      required: [true, 'Project slug is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [/^[a-z0-9_-]+$/, 'Slug can only contain lowercase alphanumeric characters, dashes, and underscores'],
    },
    apiKey: {
      type: String,
      required: [true, 'API Key is required'],
      unique: true,
      index: true,
    },
    webhookSecret: {
      type: String,
      required: [true, 'Webhook signing secret is required'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Description cannot exceed 500 characters'],
      default: '',
    },
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

projectSchema.index({ status: 1, createdAt: -1 });

export const ProjectModel = model<IProjectDocument>('Project', projectSchema);
export default ProjectModel;
