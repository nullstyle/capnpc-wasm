const std = @import("std");
const message = @import("capnpc-zig").message;
const expectEqual = std.testing.expectEqual;
const expectEqualStrings = std.testing.expectEqualStrings;
const patched_validation = @import("probe-options").patched_validation;

fn write(init: std.process.Init, path: []const u8, bytes: []const u8) !void {
    const file = try std.Io.Dir.cwd().createFile(init.io, path, .{});
    defer file.close(init.io);
    try file.writeStreamingAll(init.io, bytes);
}

fn putWord(bytes: []u8, offset: usize, word: u64) void {
    std.mem.writeInt(u64, bytes[offset..][0..8], word, .little);
}

const Shape = struct {
    count: u32 = 2,
    data_words: u16 = 1,
    pointer_words: u16 = 0,
};

fn checkList(allocator: std.mem.Allocator, bytes: []const u8, shape: Shape) !void {
    var decoded = try message.Message.init(allocator, bytes, .{});
    defer decoded.deinit();
    const list = try (try decoded.getRootStruct()).readStructList(0);
    try expectEqual(shape.count, list.len());
    for (0..shape.count) |index| {
        const item = try list.get(@intCast(index));
        const expected: u64 = if (shape.data_words == 0) 0 else if (index == 0) 42 else 99;
        try expectEqual(expected, item.readU64(0));
        if (shape.pointer_words > 0) {
            try expectEqualStrings(if (index == 0) "first" else "second", try item.readTextStrict(0));
        }
    }
}

fn builderLists(init: std.process.Init) !void {
    const Assignment = enum { same, single_far, distinct, source_landing, source_content };
    const Case = struct { name: []const u8, assignment: Assignment, shape: Shape = .{}, prefill: bool = false };
    // Cover segment aliasing with populated values and pointers. The distinct
    // case separately covers empty lists and zero-width element tag counts.
    const cases = [_]Case{
        .{ .name = "same-segment-list", .assignment = .same },
        .{ .name = "single-far-list", .assignment = .single_far },
        .{ .name = "distinct-data-list", .assignment = .distinct },
        .{ .name = "source-landing-data-list", .assignment = .source_landing },
        .{ .name = "source-content-data-list", .assignment = .source_content },
        .{ .name = "source-content-large-list", .assignment = .source_content, .shape = .{ .count = 257 } },
        .{ .name = "distinct-empty-list", .assignment = .distinct, .shape = .{ .count = 0 } },
        .{ .name = "distinct-zero-width-list", .assignment = .distinct, .shape = .{ .data_words = 0 } },
        .{ .name = "distinct-empty-zero-width-list", .assignment = .distinct, .shape = .{ .count = 0, .data_words = 0 } },
        .{ .name = "distinct-pointer-list", .assignment = .distinct, .shape = .{ .pointer_words = 1 }, .prefill = true },
        .{ .name = "source-landing-pointer-list", .assignment = .source_landing, .shape = .{ .pointer_words = 1 }, .prefill = true },
        .{ .name = "source-content-pointer-list", .assignment = .source_content, .shape = .{ .pointer_words = 1 }, .prefill = true },
    };
    for (cases) |case| {
        var builder = message.MessageBuilder.init(init.gpa);
        defer builder.deinit();
        var root = try builder.allocateStruct(0, 1);
        const landing: u32 = switch (case.assignment) {
            .same, .source_landing => 0,
            .single_far, .distinct, .source_content => try builder.createSegment(),
        };
        const content: u32 = switch (case.assignment) {
            .same, .source_content => 0,
            .single_far => landing,
            .distinct, .source_landing => try builder.createSegment(),
        };
        if (case.prefill) {
            // Existing data forces nonzero landing/content offsets. This also
            // covers source segment reuse without overwriting the root pointer.
            (try builder.allocateStructInSegment(landing, 1, 0)).writeU64(0, 0xfeed);
            (try builder.allocateStructInSegment(content, 1, 0)).writeU64(0, 0xbeef);
        }
        const shape = case.shape;
        var list = try root.writeStructListInSegments(0, shape.count, shape.data_words, shape.pointer_words, landing, content);
        for (0..shape.count) |index| {
            var item = try list.get(@intCast(index));
            if (shape.data_words > 0) item.writeU64(0, if (index == 0) 7 else 99);
            if (shape.pointer_words > 0) try item.writeText(0, if (index == 0) "before" else "second");
        }
        // Reopen through the encoded pointer, preserving the list's shape and
        // location, then mutate existing entries rather than allocating a list.
        const reopened = try (try root.getAnyPointer(0)).getStructList();
        try expectEqual(shape.count, reopened.len());
        try expectEqual(list.segment_id, reopened.segment_id);
        try expectEqual(list.elements_offset, reopened.elements_offset);
        try expectEqual(shape.data_words, reopened.data_words);
        try expectEqual(shape.pointer_words, reopened.pointer_words);
        if (shape.count > 0) {
            var first = try reopened.get(0);
            if (patched_validation) {
                // An older schema can reopen the same composite as a primitive
                // or pointer list without losing the other element sections.
                const pointer = try root.getAnyPointer(0);
                if (shape.data_words > 0) try (try pointer.getU64List()).set(0, 42);
                if (shape.pointer_words > 0) try (try pointer.getTextList()).set(0, "first");
            } else {
                if (shape.data_words > 0) first.writeU64(0, 42);
                if (shape.pointer_words > 0) try first.writeText(0, "first");
            }
        }
        const bytes = try builder.toBytes();
        defer init.gpa.free(bytes);
        try checkList(init.gpa, bytes, shape);
        const filename = try std.fmt.allocPrint(init.gpa, "{s}.bin", .{case.name});
        defer init.gpa.free(filename);
        try write(init, filename, bytes);
    }
}

fn legacyDoubleFarList(init: std.process.Init) !void {
    // Freeze the old Layout A independently of whichever writer is linked.
    // Readers retain this compatibility even after canonical emission is fixed.
    var bytes: [64]u8 = @splat(0);
    std.mem.writeInt(u32, bytes[0..4], 2, .little);
    std.mem.writeInt(u32, bytes[4..8], 2, .little);
    std.mem.writeInt(u32, bytes[8..12], 2, .little);
    std.mem.writeInt(u32, bytes[12..16], 2, .little);
    putWord(&bytes, 16, 0x0001000000000000);
    putWord(&bytes, 24, 0x0000000100000006);
    putWord(&bytes, 32, 0x0000000200000002);
    putWord(&bytes, 40, 0x0000000100000008); // Pad[1] holds the element tag.
    putWord(&bytes, 48, 42); // Content starts directly with element data.
    putWord(&bytes, 56, 99);
    try checkList(init.gpa, &bytes, .{});
    try write(init, "legacy-layout-a-list.bin", &bytes);
}

fn canonicalDoubleFarList(init: std.process.Init) !void {
    // Segment table: 3 segments of 2, 2, and 3 words. The LIST-kind tag
    // in the landing pad points at an in-content element tag, unlike Layout A.
    var bytes: [72]u8 = @splat(0);
    std.mem.writeInt(u32, bytes[0..4], 2, .little);
    std.mem.writeInt(u32, bytes[4..8], 2, .little);
    std.mem.writeInt(u32, bytes[8..12], 2, .little);
    std.mem.writeInt(u32, bytes[12..16], 3, .little);
    putWord(&bytes, 16, 0x0001000000000000); // Root: no data, one pointer.
    putWord(&bytes, 24, 0x0000000100000006); // Double-far to segment 1, word 0.
    putWord(&bytes, 32, 0x0000000200000002); // Pad[0]: far to segment 2, word 0.
    putWord(&bytes, 40, 0x0000001700000001); // Pad[1]: LIST, composite, 2 words.
    putWord(&bytes, 48, 0x0000000100000008); // Content tag: 2 elements, 1 data word.
    putWord(&bytes, 56, 42);
    putWord(&bytes, 64, 99);
    try checkList(init.gpa, &bytes, .{});
    try write(init, "canonical-double-far-list.bin", &bytes);
}

fn canonicalDoubleFarTree(init: std.process.Init) !void {
    // A standard double-far struct root with one finite child. Its data
    // section is empty (schema evolution defaults value to zero).
    var bytes: [56]u8 = @splat(0);
    std.mem.writeInt(u32, bytes[0..4], 2, .little);
    std.mem.writeInt(u32, bytes[4..8], 1, .little);
    std.mem.writeInt(u32, bytes[8..12], 2, .little);
    std.mem.writeInt(u32, bytes[12..16], 2, .little);
    putWord(&bytes, 16, 0x0000000100000006); // Root: double-far to segment 1.
    putWord(&bytes, 24, 0x0000000200000002); // Pad[0]: content at segment 2, word 0.
    putWord(&bytes, 32, 0x0001000000000000); // Pad[1]: STRUCT, zero offset, 1 pointer.
    putWord(&bytes, 40, 0x0000000100000000); // Child: near struct, 1 data word.
    putWord(&bytes, 48, 42);
    var decoded = try message.Message.init(init.gpa, &bytes, .{});
    defer decoded.deinit();
    try expectEqual(@as(usize, if (patched_validation) 4 else 2), decoded.traversal_words_used);
    const root = try decoded.getRootStruct();
    try expectEqual(@as(u64, 0), root.readU64(0));
    try expectEqual(@as(u64, 42), (try root.readStruct(0)).readU64(0));
    try write(init, "canonical-double-far-tree.bin", &bytes);
}

fn textValidation(init: std.process.Init) !void {
    for ([_]bool{ true, false }) |terminated| {
        var builder = message.MessageBuilder.init(init.gpa);
        defer builder.deinit();
        var root = try builder.allocateStruct(0, 1);
        if (terminated) {
            try root.writeText(0, "wire text");
        } else {
            // Data has the same byte-list representation but no NUL terminator.
            try root.writeData(0, "wire text");
        }
        const bytes = try builder.toBytes();
        defer init.gpa.free(bytes);
        var decoded = try message.Message.init(init.gpa, bytes, .{});
        defer decoded.deinit();
        const reader = try decoded.getRootStruct();
        // The explicit low-level compatibility reader remains lenient. Fresh
        // generated Text accessors use readTextStrict and are tested separately.
        try expectEqualStrings("wire text", try reader.readText(0));
        if (terminated) {
            try expectEqualStrings("wire text", try reader.readTextStrict(0));
        } else {
            try std.testing.expectError(error.InvalidTextPointer, reader.readTextStrict(0));
        }
        try write(init, if (terminated) "valid-text.bin" else "missing-nul.bin", bytes);
    }
}

fn expectValidationError(
    allocator: std.mem.Allocator,
    bytes: []const u8,
    options: message.Message.ValidationOptions,
    expected: anyerror,
) !void {
    var decoded = message.Message.init(allocator, bytes, options) catch |actual| {
        try expectEqual(expected, actual);
        return;
    };
    defer decoded.deinit();
    return error.ExpectedValidationRejection;
}

fn cycleValidation(init: std.process.Init) !void {
    // Positive rejection controls: a near root and self-referential child.
    var near: [24]u8 = @splat(0);
    std.mem.writeInt(u32, near[4..8], 2, .little);
    putWord(&near, 8, 0x0001000000000000);
    putWord(&near, 16, 0x00010000fffffffc);
    try expectValidationError(init.gpa, &near, .{ .nesting_limit = 1 }, error.NestingLimitExceeded);
    try expectValidationError(init.gpa, &near, .{ .traversal_limit_words = 1 }, error.TraversalLimitExceeded);
    try write(init, "near-cycle.bin", &near);

    // The same cyclic pointer section behind a canonical double-far root.
    var far: [48]u8 = @splat(0);
    std.mem.writeInt(u32, far[0..4], 2, .little);
    std.mem.writeInt(u32, far[4..8], 1, .little);
    std.mem.writeInt(u32, far[8..12], 2, .little);
    std.mem.writeInt(u32, far[12..16], 1, .little);
    putWord(&far, 16, 0x0000000100000006);
    putWord(&far, 24, 0x0000000200000002);
    putWord(&far, 32, 0x0001000000000000);
    putWord(&far, 40, 0x00010000fffffffc);
    try write(init, "double-far-cycle.bin", &far);

    // The validator charges the two landing-pad words and checks the root
    // nesting limit, so tighter controls must still reject this exact input.
    try expectValidationError(init.gpa, &far, .{ .traversal_limit_words = 1 }, error.TraversalLimitExceeded);
    try expectValidationError(init.gpa, &far, .{ .nesting_limit = 0 }, error.NestingLimitExceeded);

    if (patched_validation) {
        try expectValidationError(init.gpa, &far, .{ .nesting_limit = 1 }, error.NestingLimitExceeded);
        try expectValidationError(init.gpa, &far, .{ .traversal_limit_words = 2 }, error.TraversalLimitExceeded);
        try expectValidationError(init.gpa, &far, .{ .nesting_limit = 1, .traversal_limit_words = 2 }, error.TraversalLimitExceeded);
        return;
    }

    // Known failure W3: the pointer section is skipped. Assert the precise
    // observed gap instead of skipping the desired rejection test. A future
    // fix must replace this expectation with the matching limit errors.
    for ([_]message.Message.ValidationOptions{
        .{ .nesting_limit = 1 },
        .{ .traversal_limit_words = 2 },
        .{ .nesting_limit = 1, .traversal_limit_words = 2 },
    }) |options| {
        var decoded = message.Message.init(init.gpa, &far, options) catch |err| {
            std.debug.print("Known double-far limit gap changed: {s}; update the regression expectation\n", .{@errorName(err)});
            return error.KnownFailureChanged;
        };
        defer decoded.deinit();
        try expectEqual(@as(usize, 2), decoded.traversal_words_used);
        var reader = try decoded.getRootStruct();
        for (0..1000) |_| reader = try reader.readStruct(0);
        try expectEqual(@as(usize, 2), decoded.traversal_words_used);
    }
}

pub fn main(init: std.process.Init) !void {
    try builderLists(init);
    try legacyDoubleFarList(init);
    try canonicalDoubleFarList(init);
    try canonicalDoubleFarTree(init);
    try textValidation(init);
    try cycleValidation(init);
}
