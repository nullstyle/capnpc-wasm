const annotations = (name, importPath = `example.com/studio/${name}`) =>
  `using Cxx = import "/capnp/c++.capnp";
$Cxx.namespace("studio");
using Go = import "/go.capnp";
$Go.package("${name}");
$Go.import("${importPath}");`;

export const presets = [
  {
    id: "chat",
    name: "Chat protocol",
    description: "Two files, shared types, and a message union.",
    files: {
      "chat.capnp": `@0xcfa8e62d4b310957;
${annotations("chat")}

using Common = import "types/common.capnp";

struct Message {
  # A small protocol with room to evolve.
  id @0 :UInt64;
  author @1 :Common.Person;
  sentAt @2 :UInt64;

  union {
    text @3 :Text;
    image @4 :Image;
    reaction @5 :Common.Reaction;
  }

  struct Image {
    url @0 :Text;
    caption @1 :Text;
    width @2 :UInt32;
    height @3 :UInt32;
  }
}

struct Conversation {
  title @0 :Text = "New conversation";
  members @1 :List(Common.Person);
  messages @2 :List(Message);
}
`,
      "types/common.capnp": `@0xb4e9d1628c307fa5;
${annotations("common", "example.com/studio/chat/types")}

struct Person {
  id @0 :UInt64;
  name @1 :Text;
  online @2 :Bool = false;
}

enum Reaction {
  like @0;
  celebrate @1;
  curious @2;
}
`,
    },
  },
  {
    id: "telemetry",
    name: "Sensor telemetry",
    description: "Defaults, enums, and batches of sensor readings.",
    files: {
      "telemetry.capnp": `@0xe1a903c72f8b46d5;
${annotations("telemetry")}

struct Reading {
  sensorId @0 :Text;
  timestamp @1 :UInt64;
  value @2 :Float64;
  unit @3 :Unit = celsius;
  quality @4 :Float32 = 1.0;

  enum Unit {
    celsius @0;
    pascal @1;
    percent @2;
  }
}

struct Batch {
  station @0 :Text;
  readings @1 :List(Reading);
  sequence @2 :UInt64;
}
`,
    },
  },
  {
    id: "service",
    name: "Key-value service",
    description: "An RPC interface with typed parameters and results.",
    files: {
      "store.capnp": `@0xa73d1e8c460b92f5;
${annotations("store")}

struct Entry {
  key @0 :Text;
  value @1 :Data;
  version @2 :UInt64;
}

interface Store {
  get @0 (key :Text) -> (entry :Entry, found :Bool);
  put @1 (entry :Entry) -> (version :UInt64);
  delete @2 (key :Text) -> (removed :Bool);
  list @3 (prefix :Text) -> (entries :List(Entry));
}
`,
    },
  },
];
