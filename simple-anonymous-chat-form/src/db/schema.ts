import { integer, pgTable, primaryKey, serial, text, timestamp } from "drizzle-orm/pg-core";

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

export const discussionForms = pgTable("discussion_forms", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: false }).notNull().defaultNow(),
});

export const formMessages = pgTable("form_messages", {
  id: serial("id").primaryKey(),
  formId: integer("form_id").notNull(),
  displayName: text("display_name"),
  message: text("message").notNull(),
  parentMessageId: integer("parent_message_id"),
  editedAt: timestamp("edited_at", { withTimezone: false }),
  createdAt: timestamp("created_at", { withTimezone: false }).notNull().defaultNow(),
});

export const formMessageReactions = pgTable(
  "form_message_reactions",
  {
    messageId: integer("message_id").notNull(),
    emoji: text("emoji").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.messageId, table.emoji] }),
  }),
);
