using Hesdor.Application.Audit;
using Hesdor.Application.Authorization;
using Hesdor.Application.Common;
using Hesdor.Application.Messaging;
using Hesdor.Application.Realtime;
using Hesdor.Domain.Identity;
using Hesdor.Infrastructure.Messaging;
using Hesdor.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Hesdor.Infrastructure.Tests;

public sealed class MessagingServiceTests
{
    [Fact]
    public async Task Message_creation_records_membership_and_reaction_state()
    {
        var fixture = await MessagingFixture.CreateAsync();
        var conversation = await fixture.Service.CreateConversationAsync(new CreateConversationCommand(Domain.Messaging.ConversationType.Group, Domain.Messaging.ConversationScope.Private, "Launch", [fixture.OtherUserId]));
        var message = await fixture.Service.SendMessageAsync(new SendMessageCommand(conversation.Value!.Id, "Ship the first slice."));
        var reaction = await fixture.Service.AddReactionAsync(new AddReactionCommand(message.Value!.Id, "ack"));

        Assert.True(conversation.Succeeded);
        Assert.True(message.Succeeded);
        Assert.True(reaction.Succeeded);
        Assert.Equal(2, await fixture.Context.ConversationMembers.CountAsync());
        Assert.Single(await fixture.Context.Messages.ToArrayAsync());
        Assert.Single(await fixture.Context.MessageReactions.ToArrayAsync());
    }

    [Fact]
    public async Task Non_member_cannot_send_into_a_conversation()
    {
        var fixture = await MessagingFixture.CreateAsync();
        var conversation = new Domain.Messaging.Conversation { TenantId = fixture.TenantId, Type = Domain.Messaging.ConversationType.Group, Scope = Domain.Messaging.ConversationScope.Private, Name = "Private" };
        fixture.Context.Conversations.Add(conversation);
        fixture.Context.ConversationMembers.Add(new Domain.Messaging.ConversationMember { TenantId = fixture.TenantId, ConversationId = conversation.Id, UserId = fixture.OtherUserId, JoinedAtUtc = fixture.Clock.UtcNow });
        await fixture.Context.SaveChangesAsync();

        var result = await fixture.Service.SendMessageAsync(new SendMessageCommand(conversation.Id, "This must be rejected."));

        Assert.False(result.Succeeded);
        Assert.Equal("conversation_membership_required", result.FailureReason);
    }

    [Fact]
    public async Task Duplicate_reaction_is_rejected_without_duplicate_rows()
    {
        var fixture = await MessagingFixture.CreateAsync();
        var conversation = await fixture.Service.CreateConversationAsync(new CreateConversationCommand(Domain.Messaging.ConversationType.Group, Domain.Messaging.ConversationScope.Private, "Launch", [fixture.OtherUserId]));
        var message = await fixture.Service.SendMessageAsync(new SendMessageCommand(conversation.Value!.Id, "React once."));

        var first = await fixture.Service.AddReactionAsync(new AddReactionCommand(message.Value!.Id, "ack"));
        var second = await fixture.Service.AddReactionAsync(new AddReactionCommand(message.Value.Id, "ack"));

        Assert.True(first.Succeeded);
        Assert.False(second.Succeeded);
        Assert.Equal("reaction_already_exists", second.FailureReason);
        Assert.Single(await fixture.Context.MessageReactions.ToArrayAsync());
    }

    private sealed class MessagingFixture
    {
        private MessagingFixture(ApplicationDbContext context, MessagingService service, Guid tenantId, Guid otherUserId, TestClock clock)
        {
            Context = context;
            Service = service;
            TenantId = tenantId;
            OtherUserId = otherUserId;
            Clock = clock;
        }

        public ApplicationDbContext Context { get; }
        public MessagingService Service { get; }
        public Guid TenantId { get; }
        public Guid OtherUserId { get; }
        public TestClock Clock { get; }

        public static async Task<MessagingFixture> CreateAsync()
        {
            var tenantId = Guid.NewGuid();
            var userId = Guid.NewGuid();
            var otherUserId = Guid.NewGuid();
            var employeeId = Guid.NewGuid();
            var clock = new TestClock();
            var currentUser = new TestCurrentUser(userId, tenantId);
            var tenantContext = new TestTenantContext(tenantId);
            var options = new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase(Guid.NewGuid().ToString()).Options;
            var context = new ApplicationDbContext(options, currentUser, tenantContext, clock);
            context.Employees.Add(new Domain.People.Employee { Id = employeeId, TenantId = tenantId, FirstName = "Ada", LastName = "Lovelace", EmployeeNumber = "EMP-1", JobTitle = "Engineer" });
            context.Users.Add(new User { Id = userId, TenantId = tenantId, EmployeeId = employeeId, Email = "ada@hesdor.test", NormalizedEmail = "ADA@HESDOR.TEST", PasswordHash = "hash", DisplayName = "Ada" });
            context.Users.Add(new User { Id = otherUserId, TenantId = tenantId, Email = "grace@hesdor.test", NormalizedEmail = "GRACE@HESDOR.TEST", PasswordHash = "hash", DisplayName = "Grace" });
            await context.SaveChangesAsync();
            return new MessagingFixture(context, new MessagingService(context, tenantContext, currentUser, new TestPermissionEvaluator(), clock, new TestAuditWriter(), new TestRealtimePublisher()), tenantId, otherUserId, clock);
        }
    }

    private sealed class TestClock : IDateTimeProvider
    {
        public DateTime UtcNow => new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
    }

    private sealed class TestTenantContext(Guid tenantId) : ITenantContext
    {
        public Guid TenantId { get; } = tenantId;
        public bool HasTenant => true;
    }

    private sealed class TestCurrentUser(Guid userId, Guid tenantId) : ICurrentUserService
    {
        public bool IsAuthenticated => true;
        public Guid? UserId { get; } = userId;
        public Guid TenantId { get; } = tenantId;
        public string? Email => "ada@hesdor.test";
        public IReadOnlyCollection<string> Roles => Array.Empty<string>();
        public bool HasPermission(string permission) => permission == "channels.manage";
    }

    private sealed class TestPermissionEvaluator : IPermissionEvaluator
    {
        public Task<bool> HasPermissionAsync(string permission, CancellationToken cancellationToken = default) => Task.FromResult(permission == "channels.manage");
        public Task<IReadOnlyCollection<string>> GetPermissionsAsync(CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyCollection<string>>(["channels.manage"]);
    }

    private sealed class TestAuditWriter : IAuditWriter
    {
        public Task RecordAsync(AuditEventInput input, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class TestRealtimePublisher : IRealtimeEventPublisher
    {
        public Task PublishAsync(Guid tenantId, string eventName, object payload, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task PublishToConversationAsync(Guid tenantId, Guid conversationId, string eventName, object payload, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }
}
