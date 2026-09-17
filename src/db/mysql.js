const mysql = require('mysql2/promise');

/**
 * MySQL Database Handler for Dynamic Query Execution Analysis.
 */
class MySQLAnalyzer {
  /**
   * Initializes the MySQL connection pool configuration.
   * @param {Object} config - Database connection options.
   */
  constructor(config) {
    this.config = {
      host: config.host || 'localhost',
      port: config.port || 3306,
      database: config.database || 'test_db',
      user: config.user || 'root',
      password: config.password || 'root',
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    };
    this.pool = null;
  }

  /**
   * Gets or creates the connection pool.
   */
  getPool() {
    if (!this.pool) {
      this.pool = mysql.createPool(this.config);
    }
    return this.pool;
  }

  /**
   * Tests the connection to the MySQL database.
   * @returns {Promise<boolean>} True if connected successfully.
   */
  async testConnection() {
    try {
      const pool = this.getPool();
      const [rows] = await pool.query('SELECT 1;');
      return Array.isArray(rows);
    } catch (error) {
      throw new Error(`MySQL Connection Failed: ${error.message}`);
    }
  }

  /**
   * Executes EXPLAIN FORMAT=JSON on a query and parses execution bottlenecks.
   *
   * @param {string} sqlQuery - The SQL SELECT query to analyze.
   * @returns {Promise<Object>} Execution metrics and dynamic suggestions.
   */
  async analyzeQuery(sqlQuery) {
    const issues = [];
    let planData = null;

    // Prefer the last SELECT/WITH statement when a multi-statement script is provided
    const selectQuery = extractSelectStatement(sqlQuery);
    if (!selectQuery) {
      return {
        executed: false,
        reason: 'EXPLAIN skipped: Query is not a SELECT or WITH statement.',
        issues: [],
      };
    }

    try {
      const pool = this.getPool();

      // Execute EXPLAIN in JSON format
      const [rows] = await pool.query(`EXPLAIN FORMAT=JSON ${selectQuery}`);

      if (rows && rows[0] && rows[0].EXPLAIN) {
        planData =
          typeof rows[0].EXPLAIN === 'string' ? JSON.parse(rows[0].EXPLAIN) : rows[0].EXPLAIN;

        const queryBlock = planData.query_block;
        this.inspectQueryBlock(queryBlock, issues);
      }

      return {
        executed: true,
        totalCost: planData?.query_block?.cost_info?.query_cost || null,
        issues,
        rawPlan: planData,
      };
    } catch (error) {
      return {
        executed: false,
        error: `Failed to execute EXPLAIN on MySQL: ${error.message}`,
        issues: [
          {
            type: 'EXPLAIN_EXECUTION_ERROR',
            severity: 'HIGH',
            message: `Database error during execution: ${error.message}`,
            suggestion:
              'Verify that tables and columns exist in MySQL before running dynamic checks.',
          },
        ],
      };
    }
  }

  /**
   * Inspects MySQL EXPLAIN query_block structure for performance anti-patterns.
   */
  inspectQueryBlock(queryBlock, issues) {
    if (!queryBlock) return;

    // 1. Inspect table scan operations
    if (queryBlock.table) {
      this.inspectTableNode(queryBlock.table, issues);
    }

    // 2. Inspect JOIN tables
    if (queryBlock.nested_loop) {
      queryBlock.nested_loop.forEach((loop) => {
        if (loop.table) {
          this.inspectTableNode(loop.table, issues);
        }
      });
    }

    // 3. Detect temporary table / filesort operations
    if (queryBlock.ordering_operation) {
      if (queryBlock.ordering_operation.using_filesort) {
        issues.push({
          type: 'MYSQL_FILESORT',
          severity: 'MEDIUM',
          message: 'ORDER BY requires a filesort operation.',
          suggestion:
            'Consider adding an index covering the ORDER BY columns to avoid filesort overhead.',
        });
      }
      if (queryBlock.ordering_operation.using_temporary_table) {
        issues.push({
          type: 'MYSQL_TEMPORARY_TABLE',
          severity: 'HIGH',
          message: 'Query creates an in-memory or disk temporary table during execution.',
          suggestion: 'Optimize GROUP BY or DISTINCT clauses with proper composite indexes.',
        });
      }
    }
  }

  /**
   * Evaluates individual table access patterns.
   */
  inspectTableNode(tableNode, issues) {
    const tableName = tableNode.table_name || 'unknown_table';
    const accessType = tableNode.access_type?.toLowerCase();
    const rowsExamined = tableNode.rows_examined_per_scan || 0;

    // Full Table Scan detection (access_type ALL)
    if (accessType === 'all') {
      issues.push({
        type: 'FULL_TABLE_SCAN',
        severity: rowsExamined > 500 ? 'HIGH' : 'MEDIUM',
        message: `Full Table Scan (access_type: ALL) on MySQL table "${tableName}" (Examined rows: ${rowsExamined}).`,
        suggestion: `Add an index on table "${tableName}" covering columns used in WHERE or JOIN predicates.`,
      });
    }

    // Unindexed JOINs (access_type index / ALL without key usage)
    if (!tableNode.key && accessType !== 'all') {
      issues.push({
        type: 'MISSING_INDEX_USAGE',
        severity: 'MEDIUM',
        message: `No index key was selected for table "${tableName}".`,
        suggestion: `Review table "${tableName}" structure and create suitable indexes for filtering.`,
      });
    }
  }

  /**
   * Closes the MySQL connection pool.
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
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

module.exports = MySQLAnalyzer;
