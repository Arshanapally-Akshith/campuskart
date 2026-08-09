import { createServer, type Server as HTTPServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createSocketServer, type ChatServer } from '../src/lib/socketServer.js';

export interface RunningChatServer {
  url: string;
  close: () => Promise<void>;
}

/** Real HTTP server + Socket.IO gateway on an ephemeral port — supertest
 * can exercise the Express app directly, but socket.io-client needs an
 * actual listening server to open a websocket against. */
export async function startChatServer(app: Express): Promise<RunningChatServer> {
  const httpServer: HTTPServer = createServer(app);
  const chatServer: ChatServer = createSocketServer(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, resolve);
  });
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => chatServer.close(),
  };
}

export async function connectSocket(url: string, accessToken: string): Promise<ClientSocket> {
  const socket = ioClient(url, {
    auth: { token: accessToken },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      resolve();
    });
    socket.once('connect_error', (err: Error) => {
      reject(err);
    });
  });

  return socket;
}

export async function waitForConnectError(url: string, accessToken: string | null): Promise<Error> {
  const socket = ioClient(url, {
    auth: accessToken === null ? {} : { token: accessToken },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });

  try {
    return await new Promise<Error>((resolve, reject) => {
      socket.once('connect', () => {
        reject(new Error('Expected connect_error but the socket connected'));
      });
      socket.once('connect_error', (err: Error) => {
        resolve(err);
      });
    });
  } finally {
    socket.close();
  }
}

export function waitForEvent<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => {
    socket.once(event, (payload: T) => {
      resolve(payload);
    });
  });
}
