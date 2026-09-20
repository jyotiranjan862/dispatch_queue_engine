import mongoose, { ConnectOptions } from 'mongoose';
import { env } from './env';

const mongooseOptions: ConnectOptions = {
  maxPoolSize: env.MONGO_MAX_POOL_SIZE,
  minPoolSize: env.MONGO_MIN_POOL_SIZE,
  serverSelectionTimeoutMS: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
  socketTimeoutMS: 45000,
  autoIndex: env.NODE_ENV !== 'production',
};

// Bind lifecycle event listeners to Mongoose connection
mongoose.connection.on('connected', () => {
  console.log('[MongoDB] Connected successfully');
});

mongoose.connection.on('error', (err) => {
  console.error('[MongoDB] Connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.warn('[MongoDB] Disconnected from server');
});

/**
 * Connect to MongoDB using Mongoose with connection pooling and state guards.
 */
export async function connectDB(): Promise<typeof mongoose> {
  // If already connected, return existing connection
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  // If connection is in progress, wait until ready
  if (mongoose.connection.readyState === 2) {
    console.log('[MongoDB] Connection already in progress, waiting...');
    return mongoose;
  }

  try {
    await mongoose.connect(env.MONGODB_URI, mongooseOptions);
    return mongoose;
  } catch (err) {
    console.error('[MongoDB] Failed to connect to database:', err);
    throw err;
  }
}

/**
 * Gracefully disconnect from MongoDB.
 */
export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log('[MongoDB] Disconnected gracefully');
  }
}

/**
 * Check MongoDB connection health status.
 */
export function checkDBHealth(): { isHealthy: boolean; state: string } {
  const states: Record<number, string> = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  const currentState = mongoose.connection.readyState;
  return {
    isHealthy: currentState === 1,
    state: states[currentState] || 'unknown',
  };
}

export default connectDB;
