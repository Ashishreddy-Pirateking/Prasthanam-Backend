const mongoose = require("mongoose");

const timelineItemSchema = new mongoose.Schema(
  {
    year: { type: String, trim: true },
    title: { type: String, trim: true },
    desc: { type: String, trim: true },
  },
  { _id: false }
);

const navarasaItemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, trim: true },
    subtitle: { type: String, trim: true },
    plays: [{ type: String, trim: true }],
  },
  { _id: false }
);

const castBatchSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    yearRange: { type: String, required: true, trim: true },
    members: [{ type: String, trim: true }],
    photos: [{ type: String, trim: true }],
  },
  { _id: false }
);

const governorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    year: { type: String, trim: true },
    role: { type: String, trim: true },
    quote: { type: String, trim: true },
    funFact: { type: String, trim: true },
    department: { type: String, trim: true },
    contactInfo: { type: String, trim: true },
    zodiacSign: { type: String, trim: true },
    img: { type: String, trim: true },
  },
  { _id: false }
);

const latestEventSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true },
    poster: { type: String, trim: true },
    date: { type: String, trim: true },
    time: { type: String, trim: true },
    venue: { type: String, trim: true },
    description: { type: String, trim: true },
  },
  { _id: false }
);

const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "main" },
    gallery: {
      images: [{ type: String, trim: true }],
    },
    timeline: [timelineItemSchema],
    navarasas: [navarasaItemSchema],
    castBatches: [castBatchSchema],
    governors: [governorSchema],
    latestEvent: latestEventSchema,
    updatedBy: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SiteContent", siteContentSchema);
