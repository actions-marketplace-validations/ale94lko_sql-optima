const { Pool } = require('pg');

/**
 * PostgreSQL Database Handler for Dynamic Query Execution Analysis.
 */
class PostgresAnalyzer {
  /**
   * Initializes the PostgreSQL connection pool.
   * @param {Object} config - Database connection options.
   */
  constructor(config) {
    this.pool = new Pool({
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'test_db',
      user: config.user || 'postgres',
      password: config.password || 'root',
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      max: 5,
    });
  }

  /**
   * Tests the connection to the PostgreSQL database.
   * @returns {Promise<boolean>} True if connected successfully.
   */
  async testConnection() {
    let client;
    try {
      client = await this.pool.connect();
      await client.query('SELECT 1;');
      return true;
    } catch (error) {
      throw new Error(`PostgreSQL Connection Failed: ${error.message}`);
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Executes EXPLAIN ANALYZE on a query and parses execution bottlenecks.
   *
   * @param {string} sqlQuery - The SQL SELECT query to analyze.
   * @returns {Promise<Object>} Execution metrics and dynamic suggestions.
   */
  async analyzeQuery(sqlQuery) {
    let client;
    const issues = [];
    let planData = null;

    // Prefer the last SELECT/WITH statement when a multi-statement script is provided
    const selectQuery = extractSelectStatement(sqlQuery);
    if (!selectQuery) {
      return {
        executed: false,
        reason: 'EXPLAIN ANALYZE skipped: Query is not a SELECT or WITH statement.',
        issues: [],
      };
    }

    try {
      client = await this.pool.connect();

      // Wrap EXPLAIN in JSON format with cost and buffer metrics
      const explainSql = `EXPLAIN (ANALYZE, COSTS, VERBOSE, BUFFERS, FORMAT JSON) ${selectQuery}`;
      const res = await client.query(explainSql);

      if (res.rows && res.rows[0]) {
        planData = res.rows[0]['QUERY PLAN'][0];
        const rootNode = planData.Plan;

        // Traverse the execution tree to find expensive operations
        this.inspectPlanNode(rootNode, issues);
      }

      return {
        executed: true,
        executionTimeMs: planData ? planData['Execution Time'] : null,
        planningTimeMs: planData ? planData['Planning Time'] : null,
        totalCost: planData?.Plan ? planData.Plan['Total Cost'] : null,
        issues,
        rawPlan: planData,
      };
    } catch (error) {
      return {
        executed: false,
        error: `Failed to execute EXPLAIN ANALYZE: ${error.message}`,
        issues: [
          {
            type: 'EXPLAIN_EXECUTION_ERROR',
            severity: 'HIGH',
            message: `Database error during execution: ${error.message}`,
            suggestion:
              'Ensure referenced tables/columns exist in the database schema before running dynamic checks.',
          },
        ],
      };
    } finally {
      if (client) client.release();
    }
  }

  /**
   * Recursively inspects execution plan nodes for bottlenecks.
   */
  inspectPlanNode(node, issues) {
    if (!node) return;

    const nodeType = node['Node Type'];
    const totalCost = node['Total Cost'] || 0;
    const actualTotalTime = node['Actual Total Time'] || 0;

    // 1. Detect Sequential Scans (Seq Scan)
    if (nodeType === 'Seq Scan') {
      const relation = node['Relation Name'] || 'unknown_table';
      const rows = node['Actual Rows'] || 0;

      issues.push({
        type: 'SEQUENTIAL_SCAN',
        severity: rows > 1000 ? 'HIGH' : 'MEDIUM',
        message: `Sequential Scan detected on table "${relation}" (Rows fetched: ${rows}, Cost: ${totalCost}).`,
        suggestion: `Consider adding an index to table "${relation}" covering the filter conditions: ${node['Filter'] || 'N/A'}.`,
      });
    }

    // 2. Detect Disk-based Sorts
    if (nodeType === 'Sort' && node['Sort Space Type'] === 'Disk') {
      issues.push({
        type: 'DISK_SORT',
        severity: 'HIGH',
        message: `Sort operation spilled to disk (Used Space: ${node['Sort Space Used']} kB).`,
        suggestion:
          'Increase work_mem setting or optimize indexing on ORDER BY columns to perform in-memory sorting.',
      });
    }

    // 3. Detect Nested Loop joins with high cost
    if (nodeType === 'Nested Loop' && actualTotalTime > 100) {
      issues.push({
        type: 'HIGH_COST_NESTED_LOOP',
        severity: 'MEDIUM',
        message: `Nested Loop join took ${actualTotalTime}ms to complete.`,
        suggestion: 'Verify that join key columns on both tables are properly indexed.',
      });
    }

    // Recurse child nodes
    if (Array.isArray(node.Plans)) {
      node.Plans.forEach((child) => this.inspectPlanNode(child, issues));
    }
  }

  /**
   * Closes the connection pool.
   */
  async close() {
    await this.pool.end();
  }
}

/**
 * Extracts the last SELECT or WITH statement from a SQL script.
 * @param {string} sqlQuery
 * @returns {string|null}
 */
function extractSelectStatement(sqlQuery) {
  const statements = sqlQuery
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (let i = statements.length - 1; i >= 0; i -= 1) {
    const trimmed = statements[i].toLowerCase();
    if (trimmed.startsWith('select') || trimmed.startsWith('with')) {
      return statements[i];
    }
  }

  return null;
}

module.exports = PostgresAnalyzer;
