const std = @import("std");
const capnpc = @import("capnpc-zig");
const generated = @import("generated");

test "generated Person roundtrips through the pinned capnp-zig runtime" {
    const allocator = std.testing.allocator;
    const id: u64 = 0xfedc_ba98_7654_3210;
    var builder = capnpc.message.MessageBuilder.init(allocator);
    defer builder.deinit();
    var person = try generated.Person.Builder.init(&builder);

    // An untouched union selects its first member; switching to email must
    // preserve the independent fields and their schema defaults.
    {
        const bytes = try builder.toBytes();
        defer allocator.free(bytes);
        var decoded = try capnpc.message.Message.init(allocator, bytes, .{});
        defer decoded.deinit();
        const initial = try generated.Person.Reader.init(&decoded);
        try std.testing.expectEqual(generated.Person.WhichTag.absent, try initial.which());
        try initial.getAbsent();
        try std.testing.expectError(error.WrongUnionMember, initial.getEmail());
    }

    try person.setId(id);
    try person.setName("Zoë 🦀");
    try person.setEmail("zoë@example.test");
    var addresses = try person.initAddresses(1);
    var address = try addresses.get(0);
    try address.setCity("Tromsø");
    // Leave country and status unset to exercise pointer and enum defaults.

    const bytes = try builder.toBytes();
    defer allocator.free(bytes);
    var decoded = try capnpc.message.Message.init(allocator, bytes, .{});
    defer decoded.deinit();
    const reader = try generated.Person.Reader.init(&decoded);
    try std.testing.expectEqual(id, try reader.getId());
    try std.testing.expectEqualStrings("Zoë 🦀", try reader.getName());
    try std.testing.expectEqual(generated.common.Status.Active, try reader.getStatus());
    const read_addresses = try reader.getAddresses();
    try std.testing.expectEqual(@as(u32, 1), read_addresses.len());
    const read_address = try read_addresses.get(0);
    try std.testing.expectEqualStrings("Tromsø", try read_address.getCity());
    try std.testing.expectEqualStrings("US", try read_address.getCountry());
    try std.testing.expectEqual(generated.Person.WhichTag.email, try reader.which());
    try std.testing.expectEqualStrings("zoë@example.test", try reader.getEmail());
    try std.testing.expectError(error.WrongUnionMember, reader.getAbsent());
}

test "generated interface parameter types roundtrip" {
    const allocator = std.testing.allocator;
    var builder = capnpc.message.MessageBuilder.init(allocator);
    defer builder.deinit();
    var params = try generated.Directory.Find.Params.Builder.init(&builder);
    try params.setId(std.math.maxInt(u64));

    const bytes = try builder.toBytes();
    defer allocator.free(bytes);
    var decoded = try capnpc.message.Message.init(allocator, bytes, .{});
    defer decoded.deinit();
    const reader = try generated.Directory.Find.Params.Reader.init(&decoded);
    try std.testing.expectEqual(std.math.maxInt(u64), try reader.getId());
}
