const std = @import("std");
const capnpc = @import("capnpc-zig");
const generated = @import("generated");

fn checkDefaults(value: generated.Values.Reader) !void {
    const raw = try value.getRaw();
    try std.testing.expectEqual(@as(usize, 256), raw.len);
    for (raw, 0..) |byte, i| try std.testing.expectEqual(@as(u8, @intCast(i)), byte);
    try std.testing.expectEqualStrings("Embedded text: café, Tromsø, 🦀.\nSecond line.\n", try value.getText());
    try std.testing.expectEqualSlices(u8, &.{ 0, 127, 128, 255, 0 }, try value.getInlineData());
    try std.testing.expectEqualStrings("NUL:\x00; café 🦀\n", try value.getInlineText());
    try std.testing.expectEqual(std.math.maxInt(u64), try value.getHigh());
    try std.testing.expectEqual(std.math.minInt(i64), try value.getLow());
    try std.testing.expectEqual(std.math.maxInt(i64), try value.getHighSigned());
    const numbers = try value.getNumbers();
    try std.testing.expectEqual(@as(u32, 3), numbers.len());
    try std.testing.expectEqual(@as(u64, 0), try numbers.get(0));
    try std.testing.expectEqual(@as(u64, 1) << 63, try numbers.get(1));
    try std.testing.expectEqual(std.math.maxInt(u64), try numbers.get(2));
    const record = try value.getRecord();
    try std.testing.expectEqualStrings("constant é", try record.getLabel());
    try std.testing.expectEqual(generated.common.Record.Mode.Active, try record.getMode());
    const records = try value.getRecords();
    try std.testing.expectEqual(@as(u32, 2), records.len());
    try std.testing.expectEqualStrings("default 🦀", try (try records.get(1)).getLabel());
    const details = value.getDetails();
    try std.testing.expect(try details.getEnabled());
    try std.testing.expectEqual(generated.common.Record.Mode.Archived, try details.getMode());
    try std.testing.expectEqualStrings("tagged", try value.getTagged());
}

test "generated embedded values and complex defaults survive a union group roundtrip" {
    const allocator = std.testing.allocator;
    var builder = capnpc.message.MessageBuilder.init(allocator);
    defer builder.deinit();
    var value = try generated.Values.Builder.init(&builder);
    {
        const bytes = try builder.toBytes();
        defer allocator.free(bytes);
        var decoded = try capnpc.message.Message.init(allocator, bytes, .{});
        defer decoded.deinit();
        const initial = try generated.Values.Reader.init(&decoded);
        try checkDefaults(initial);
        try std.testing.expectEqual(generated.Values.WhichTag.none, try initial.which());
    }
    var selected = value.initSelected();
    try selected.setName("selected 🦀");
    try selected.setPayload(&.{ 0, 128, 255 });

    const bytes = try builder.toBytes();
    defer allocator.free(bytes);
    var decoded = try capnpc.message.Message.init(allocator, bytes, .{});
    defer decoded.deinit();
    const reader = try generated.Values.Reader.init(&decoded);
    try checkDefaults(reader);
    try std.testing.expectEqual(generated.Values.WhichTag.selected, try reader.which());
    const read_selected = try reader.getSelected();
    try std.testing.expectEqualStrings("selected 🦀", try read_selected.getName());
    try std.testing.expectEqualSlices(u8, &.{ 0, 128, 255 }, try read_selected.getPayload());
}
