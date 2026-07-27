# Ledgerly transaction import format

Ledgerly reads the **first worksheet** in an Excel file, or the rows in a CSV file.

## Required header row

```text
Date,Type,Amount,Description,Category,Account,From Account,To Account,Currency
```

## Rules

| Column | Expense | Income | Transfer |
|---|---|---|---|
| Date | Required | Required | Required |
| Type | `Expense` | `Income` | `Transfer` |
| Amount | Positive number | Positive number | Positive number |
| Description | Optional | Optional | Optional |
| Category | Required | Required | Leave blank |
| Account | Required* | Required* | Leave blank |
| From Account | Leave blank | Leave blank | Required* |
| To Account | Leave blank | Leave blank | Required |
| Currency | `AED` or blank | `AED` or blank | `AED` or blank |

`*` The import screen can supply a fallback account when this field is blank.

- Prefer dates in `YYYY-MM-DD` format. `DD/MM/YYYY` is also accepted.
- Account and category names are matched case-insensitively.
- Accounts must already exist in Ledgerly.
- Missing expense or income categories can be created automatically.
- Amounts may contain commas and are rounded to two decimal places.
- The transaction type controls the direction, so use positive amounts.
- Descriptions can contain up to 120 characters.

## Examples

```csv
Date,Type,Amount,Description,Category,Account,From Account,To Account,Currency
2026-07-01,Expense,125.50,Weekly groceries,Groceries,Visa Card,,,AED
2026-07-05,Income,15000.00,Monthly salary,Salary,Current Account,,,AED
2026-07-10,Transfer,3000.00,Move money to savings,,,Current Account,Savings,AED
2026-07-15,Transfer,1200.00,Credit card payment,,,Current Account,Visa Card,AED
```

A credit-card purchase is an **Expense** assigned to the credit-card account. A credit-card payment is a **Transfer** from the paying account to the credit-card account.
