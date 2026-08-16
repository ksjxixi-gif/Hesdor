namespace Hesdor.Domain.Billing;

public enum Feature
{
    AccessControl = 0,
    Attendance = 1,
    Work = 2,
    Messaging = 3,
    Files = 4,
    AdvancedReports = 5,
    VisitorManagement = 6,
    Audit = 7
}

public enum LimitType
{
    MaxEmployees = 0,
    MaxLocations = 1,
    MaxDoors = 2,
    MaxActiveCredentials = 3,
    StorageBytes = 4,
    AuditRetentionDays = 5
}

public enum BillingCycle
{
    Monthly = 0,
    Annual = 1,
    Manual = 2
}

public enum SubscriptionStatus
{
    Trialing = 0,
    Active = 1,
    PastDue = 2,
    GracePeriod = 3,
    Canceled = 4,
    Expired = 5
}

public enum BillingProvider
{
    Manual = 0,
    Stripe = 1,
    HyperPay = 2,
    PayTabs = 3,
    BankTransfer = 4
}

public enum BillingEventStatus
{
    Received = 0,
    Processed = 1,
    Failed = 2,
    Ignored = 3
}
