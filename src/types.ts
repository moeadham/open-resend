export type DeliveryQueueMessage = { deliveryId: string };

export type EmailEventMessage = {
  type: string;
  source?: { domain?: string };
  payload: {
    eventId: string;
    messageId?: string;
    recipient?: string;
    terminal?: boolean;
    delivery?: { status?: string };
    bounce?: { type?: string; reason?: string };
    failure?: { reason?: string };
    rejection?: { reason?: string; detail?: string };
  };
};

export type QueueBody = DeliveryQueueMessage | EmailEventMessage;

export type SegmentRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type TopicRow = {
  id: string;
  name: string;
  description: string | null;
  default_subscription: "opt_in" | "opt_out";
  visibility: "public" | "private";
  created_at: string;
  updated_at: string;
};

export type ContactRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  properties_json: string;
  unsubscribed: number;
  suppression_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type SenderRow = {
  id: string;
  domain_id: string;
  email: string;
  name: string;
  company_name: string | null;
  reply_to: string | null;
  postal_address: string;
  active: number;
  created_at: string;
  updated_at: string;
};

export type BroadcastRow = {
  id: string;
  name: string;
  segment_id: string;
  topic_id: string | null;
  sender_id: string;
  from_value: string;
  subject: string;
  reply_to_json: string | null;
  preview_text: string | null;
  html: string | null;
  text: string | null;
  status: string;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DeliveryDetail = {
  id: string;
  broadcast_id: string;
  contact_id: string | null;
  recipient: string;
  status: string;
  attempts: number;
  message_id: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  preview_text: string | null;
  reply_to_json: string | null;
  broadcast_status: string;
  segment_id: string;
  topic_id: string | null;
  sender_email: string;
  sender_name: string;
  sender_company_name: string;
  sender_reply_to: string | null;
  sender_domain: string;
  postal_address: string;
  sender_active: number;
};

export type AppErrorName =
  | "validation_error"
  | "invalid_parameter"
  | "missing_required_field"
  | "not_found"
  | "restricted_api_key"
  | "invalid_api_key"
  | "invalid_idempotent_request"
  | "concurrent_idempotent_requests"
  | "conflict"
  | "application_error";
