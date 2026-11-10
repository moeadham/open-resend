import { receiveEmail } from "./incoming-email";
import { deliverWebhook } from "./webhooks";
import {
  sendTransactionalEmail,
  updateTransactionalStatus,
} from "./outgoing-email";
import { maintainEmail } from "./email-maintenance";
import { adminApp } from "./admin";
import { apiApp } from "./api";
import { isAdminRequest, isApiRequest } from "./auth";
import { logError } from "./lib";
import {
  processBroadcastQueueMessage,
  processDeadLetter,
  processDeliveryMessage,
  processEmailEvent,
} from "./delivery";
import type {
  BroadcastQueueMessage,
  DeliveryQueueMessage,
  EmailEventMessage,
  QueueBody,
} from "./types";

export { BroadcastSchedule } from "./schedule";

export default {
  email: receiveEmail,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await maintainEmail(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (isAdminRequest(request, env)) return adminApp.fetch(request, env);
      if (isApiRequest(request, env)) return apiApp.fetch(request, env);
      return Response.json(
        {
          name: "not_found",
          message: "This hostname is not configured for the service.",
          statusCode: 404,
        },
        { status: 404 },
      );
    } catch (error) {
      logError("unhandled fetch error", error, {
        path: new URL(request.url).pathname,
      });
      return Response.json(
        {
          name: "application_error",
          message: "Internal server error.",
          statusCode: 500,
        },
        { status: 500 },
      );
    }
  },

  async queue(batch: MessageBatch<QueueBody>, env: Env): Promise<void> {
    if (batch.queue === env.DEAD_LETTER_QUEUE_NAME) {
      for (const message of batch.messages) {
        if ("transactionalId" in message.body) {
          await env.DB.prepare(
            "UPDATE transactional_recipients SET status='failed',error='Queue retries exhausted' WHERE email_id=? AND status='pending'",
          )
            .bind(message.body.transactionalId)
            .run();
          await updateTransactionalStatus(env, message.body.transactionalId);
          message.ack();
        }
      }
      const legacy = {
        ...batch,
        messages: batch.messages.filter(
          (message) => !("transactionalId" in message.body),
        ),
      };
      await processDeadLetter(
        legacy as MessageBatch<DeliveryQueueMessage | BroadcastQueueMessage>,
        env,
      );
      return;
    }
    if (
      batch.queue !== env.EMAIL_EVENTS_QUEUE_NAME &&
      batch.queue !== env.DELIVERY_QUEUE_NAME &&
      batch.queue !== env.WEBHOOK_QUEUE_NAME
    ) {
      throw new Error(
        `Received a batch from an unconfigured queue: ${batch.queue}`,
      );
    }
    for (const message of batch.messages) {
      try {
        if (batch.queue === env.WEBHOOK_QUEUE_NAME) {
          if (!("webhookDeliveryId" in message.body))
            throw new Error("Invalid webhook queue message");
          await deliverWebhook(env, message.body.webhookDeliveryId);
          message.ack();
        } else if (
          batch.queue === env.DELIVERY_QUEUE_NAME &&
          "transactionalId" in message.body
        ) {
          await sendTransactionalEmail(env, message.body.transactionalId);
          message.ack();
        } else if (batch.queue === env.EMAIL_EVENTS_QUEUE_NAME) {
          await processEmailEvent(message as Message<EmailEventMessage>, env);
        } else if ("broadcastId" in message.body) {
          await processBroadcastQueueMessage(
            message as Message<BroadcastQueueMessage>,
            env,
          );
        } else {
          await processDeliveryMessage(
            message as Message<DeliveryQueueMessage>,
            env,
          );
        }
      } catch (error) {
        logError("queue message failed", error, {
          queue: batch.queue,
          messageId: message.id,
        });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, QueueBody>;
