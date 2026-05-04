import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  displayName: text("display_name"),
  message: text("message").notNull(),
  parentMessageId: integer("parent_message_id"),
  createdAt: timestamp("created_at", { withTimezone: false }).notNull().defaultNow(),
});

export const chatUserBadges = pgTable("chat_user_badges", {
  normalizedName: text("normalized_name").primaryKey(),
  badge: text("badge").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: false }).notNull().defaultNow(),
});
