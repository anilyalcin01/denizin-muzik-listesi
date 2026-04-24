// Task Queue Manager
class TaskQueue {
  constructor() {
    this.tasks = [];
    this.currentTask = null;
    this.history = [];
    this.status = 'idle';
  }

  addTask(task) {
    const taskObj = {
      id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
      ...task,
      status: 'pending',
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      error: null,
      output: null
    };
    this.tasks.push(taskObj);
    return taskObj.id;
  }

  addTasks(taskList) {
    return taskList.map(task => this.addTask(task));
  }

  getNext() {
    return this.tasks.find(t => t.status === 'pending');
  }

  markRunning(taskId) {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = 'running';
      task.startedAt = new Date();
      this.currentTask = task;
    }
    this.status = 'running';
  }

  markCompleted(taskId, output) {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = 'completed';
      task.completedAt = new Date();
      task.output = output;
      this.history.push(task);
    }
    this.currentTask = null;
  }

  markFailed(taskId, error) {
    const task = this.tasks.find(t => t.id === taskId);
    if (task) {
      task.status = 'failed';
      task.completedAt = new Date();
      task.error = error;
      this.history.push(task);
    }
    this.currentTask = null;
    this.status = 'failed';
  }

  getStatus() {
    return {
      status: this.status,
      total: this.tasks.length,
      pending: this.tasks.filter(t => t.status === 'pending').length,
      running: this.tasks.filter(t => t.status === 'running').length,
      completed: this.tasks.filter(t => t.status === 'completed').length,
      failed: this.tasks.filter(t => t.status === 'failed').length,
      currentTask: this.currentTask,
      tasks: this.tasks
    };
  }

  clear() {
    this.tasks = [];
    this.currentTask = null;
    this.status = 'idle';
  }
}

module.exports = TaskQueue;
