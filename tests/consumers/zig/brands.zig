const std = @import("std");
const capnpc = @import("capnpc-zig");
const generated = @import("generated").schema;

fn checkDefaults(value: generated.Brands.Reader) !void {
    const text = try value.brands().getText();
    try std.testing.expectEqualStrings("branded 🦀", try text.getValue());
    const nested = try (try (try value.brands().getNested()).getValue()).getValue();
    try std.testing.expectEqualStrings("constant é", try nested.getLabel());
    const pair = try value.brands().getPair();
    try std.testing.expectEqualStrings("outer", try pair.getFirst());
    try std.testing.expectEqualSlices(u8, &.{ 0, 128, 255 }, try pair.getSecond());
    const pointers = try value.getPointers();
    const any_record = generated.common.Record.Reader.wrap(try (try pointers.getAny()).getStruct());
    try std.testing.expectEqualStrings("constant é", try any_record.getLabel());
    const struct_record = generated.common.Record.Reader.wrap(try pointers.pointerKinds().getStructure());
    try std.testing.expectEqualStrings("constant é", try struct_record.getLabel());
    const list = try (try pointers.pointerKinds().getList()).getTextList();
    try std.testing.expectEqual(@as(u32, 2), list.len());
    try std.testing.expectEqualStrings("first", try list.get(0));
    try std.testing.expectEqualStrings("second", try list.get(1));
}

test "generated bound and unbound generic pointers preserve defaults and roundtrip" {
    const allocator = std.testing.allocator;
    var builder = capnpc.message.MessageBuilder.init(allocator);
    defer builder.deinit();
    var value = try generated.Brands.Builder.init(&builder);
    {
        const bytes = try builder.toBytes();
        defer allocator.free(bytes);
        var decoded = try capnpc.message.Message.init(allocator, bytes, .{});
        defer decoded.deinit();
        try checkDefaults(try generated.Brands.Reader.init(&decoded));
    }
    var unbound = try value.initUnbound();
    try unbound.setValueText("unbound pointer 🦀");

    const bytes = try builder.toBytes();
    defer allocator.free(bytes);
    var decoded = try capnpc.message.Message.init(allocator, bytes, .{});
    defer decoded.deinit();
    const reader = try generated.Brands.Reader.init(&decoded);
    try checkDefaults(reader);
    const read_pointer = try (try reader.getUnbound()).getValue();
    try std.testing.expectEqualStrings("unbound pointer 🦀", try read_pointer.getText());
}
