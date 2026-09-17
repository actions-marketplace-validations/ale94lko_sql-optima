import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MySQLAnalyzer = require('./mysql');

describe('MySQLAnalyzer', () => {
  let query;
  let end;
  let createPool;

  beforeEach(() => {
    query = vi.fn();
    end = vi.fn().mockResolvedValue(undefined);
    createPool = vi.fn(() => ({ query, end }));
  });

  it('applies default connection settings', () => {
    const analyzer = new MySQLAnalyzer({}, { createPool });
    expect(analyzer.config).toMatchObject({
      host: 'localhost',
      port: 3306,
      database: 'test_db',
      user: 'root',
      password: 'root',
    });
  });

  it('reuses a single pool instance', () => {
    const analyzer = new MySQLAnalyzer({ host: 'db' }, { createPool });
    const first = analyzer.getPool();
    const second = analyzer.getPool();

    expect(first).toBe(second);
    expect(createPool).toHaveBeenCalledTimes(1);
  });

  it('tests the connection successfully', async () => {
    query.mockResolvedValue([[{ 1: 1 }]]);
    const analyzer = new MySQLAnalyzer({}, { createPool });

    await expect(analyzer.testConnection()).resolves.toBe(true);
  });

  it('wraps connection failures', async () => {
    query.mockRejectedValue(new Error('denied'));
    const analyzer = new MySQLAnalyzer({}, { createPool });

    await expect(analyzer.testConnection()).rejects.toThrow('MySQL Connection Failed: denied');
  });

  it('skips EXPLAIN for non-select statements', async () => {
    const analyzer = new MySQLAnalyzer({}, { createPool });
    const result = await analyzer.analyzeQuery('UPDATE t SET a = 1;');

    expect(result.executed).toBe(false);
    expect(result.reason).toContain('EXPLAIN skipped');
    expect(createPool).not.toHaveBeenCalled();
  });

  it('parses string EXPLAIN payloads and flags full scans plus filesorts', async () => {
    const plan = {
      query_block: {
        cost_info: { query_cost: '12.34' },
        table: {
          table_name: 'users',
          access_type: 'ALL',
          rows_examined_per_scan: 900,
        },
        nested_loop: [
          {
            table: {
              table_name: 'orders',
              access_type: 'ref',
            },
          },
        ],
        ordering_operation: {
          using_filesort: true,
          using_temporary_table: true,
        },
      },
    };

    query.mockResolvedValue([[{ EXPLAIN: JSON.stringify(plan) }]]);

    const analyzer = new MySQLAnalyzer({}, { createPool });
    const result = await analyzer.analyzeQuery(`
      CREATE TABLE ignored (id INT);
      SELECT * FROM users ORDER BY name;
    `);

    expect(result.executed).toBe(true);
    expect(result.totalCost).toBe('12.34');
    expect(result.issues.map((issue) => issue.type)).toEqual(
      expect.arrayContaining([
        'FULL_TABLE_SCAN',
        'MISSING_INDEX_USAGE',
        'MYSQL_FILESORT',
        'MYSQL_TEMPORARY_TABLE',
      ]),
    );
    expect(result.issues.find((issue) => issue.type === 'FULL_TABLE_SCAN').severity).toBe('HIGH');
  });

  it('parses object EXPLAIN payloads and uses medium severity for small scans', async () => {
    query.mockResolvedValue([
      [
        {
          EXPLAIN: {
            query_block: {
              table: {
                table_name: 'tiny',
                access_type: 'ALL',
                rows_examined_per_scan: 10,
              },
            },
          },
        },
      ],
    ]);

    const analyzer = new MySQLAnalyzer({}, { createPool });
    const result = await analyzer.analyzeQuery('WITH cte AS (SELECT 1 AS id) SELECT * FROM cte;');

    expect(result.executed).toBe(true);
    expect(result.issues[0].severity).toBe('MEDIUM');
  });

  it('returns an execution error issue when EXPLAIN fails', async () => {
    query.mockRejectedValue(new Error('unknown table'));
    const analyzer = new MySQLAnalyzer({}, { createPool });
    const result = await analyzer.analyzeQuery('SELECT * FROM missing;');

    expect(result.executed).toBe(false);
    expect(result.issues[0].type).toBe('EXPLAIN_EXECUTION_ERROR');
  });

  it('closes an open pool and no-ops when there is none', async () => {
    const analyzer = new MySQLAnalyzer({}, { createPool });
    await analyzer.close();

    analyzer.getPool();
    await analyzer.close();
    expect(end).toHaveBeenCalledTimes(1);
    expect(analyzer.pool).toBeNull();
  });

  it('ignores empty query blocks safely', () => {
    const analyzer = new MySQLAnalyzer({}, { createPool });
    const issues = [];
    analyzer.inspectQueryBlock(null, issues);
    expect(issues).toEqual([]);
  });

  it('uses unknown_table when table metadata is missing', () => {
    const analyzer = new MySQLAnalyzer({}, { createPool });
    const issues = [];
    analyzer.inspectTableNode({ access_type: 'ALL', rows_examined_per_scan: 1 }, issues);
    expect(issues[0].message).toContain('unknown_table');
  });
});
