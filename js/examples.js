/**
 * Example Rust Programs
 *
 * Pre-loaded examples that demonstrate different memory patterns.
 */

const RustExamples = [
  {
    id: 'basics',
    title: 'Stack vs Heap Basics',
    description: 'Primitives, String, Vec, Box',
    code: `fn main() {
    // Stack: primitives
    let x: i32 = 42;
    let y: f64 = 3.14;
    let flag: bool = true;

    // Stack pointer + Heap data
    let name = String::from("hello, world");
    let numbers = vec![1, 2, 3, 4, 5];
    let boxed = Box::new(99);

    // Stack: reference to .rodata
    let greeting: &str = "Hello!";

    // Stack: fixed-size array
    let matrix: [i32; 4] = [1, 2, 3, 4];

    println!("{} {} {} {}", x, y, flag, greeting);
}`,
  },
  {
    id: 'ownership',
    title: 'Ownership & Smart Pointers',
    description: 'Rc, Arc, Box<dyn Trait>',
    code: `use std::rc::Rc;
use std::sync::Arc;

trait Drawable {
    fn draw(&self);
}

struct Circle {
    radius: f64,
}

impl Drawable for Circle {
    fn draw(&self) {
        println!("Drawing circle r={}", self.radius);
    }
}

fn main() {
    // Rc: reference-counted heap allocation
    let shared = Rc::new(vec![1, 2, 3]);
    let clone1 = Rc::clone(&shared);

    // Arc: atomic reference-counted (thread-safe)
    let atomic = Arc::new(String::from("shared across threads"));

    // Trait object: vtable in .rodata, data on heap
    let shape: Box<dyn Drawable> = Box::new(Circle { radius: 5.0 });

    // Stack-only: the struct itself
    let local_circle = Circle { radius: 3.0 };
}`,
  },
  {
    id: 'statics',
    title: 'Static & Const Data',
    description: '.rodata, .data, .bss segments',
    code: `// .rodata: immutable static
static APP_NAME: &str = "Rust Visualizer";
static VERSION: u32 = 1;

// .data: mutable static (unsafe to access)
static mut COUNTER: i32 = 10;

// .bss: zero-initialized (no binary cost)
static ZERO_BUF: [u8; 1024] = [0; 1024];
static INIT_FLAG: bool = false;

// .rodata: compile-time constant (may be inlined)
const MAX_SIZE: usize = 256;
const PI: f64 = 3.14159265358979;

fn main() {
    // .rodata reference
    let name = APP_NAME;

    // Stack allocation
    let local_max = MAX_SIZE;

    println!("App: {} v{}, max={}", name, VERSION, local_max);
}`,
  },
  {
    id: 'collections',
    title: 'Collections & Maps',
    description: 'HashMap, BTreeMap, VecDeque, etc.',
    code: `use std::collections::HashMap;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::collections::LinkedList;
use std::collections::HashSet;

fn main() {
    // All collections: metadata on stack, storage on heap
    let mut scores: HashMap<String, i32> = HashMap::new();
    let mut sorted: BTreeMap<i32, String> = BTreeMap::new();
    let mut queue: VecDeque<i32> = VecDeque::new();
    let mut list: LinkedList<f64> = LinkedList::new();
    let mut unique: HashSet<String> = HashSet::new();

    // Vec with known capacity
    let mut buffer: Vec<u8> = Vec::with_capacity(1024);

    // Nested heap types: Vec<Vec<String>>
    let mut grid: Vec<Vec<String>> = Vec::new();

    // String keys go to heap too
    let key = String::from("player1");
}`,
  },
  {
    id: 'closures',
    title: 'Closures & Functions',
    description: 'Capture semantics, fn pointers',
    code: `fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn apply(f: fn(i32, i32) -> i32, x: i32, y: i32) -> i32 {
    f(x, y)
}

fn main() {
    // Stack: closure captures by reference
    let multiplier = 3;
    let multiply = |x: i32| x * multiplier;

    // Stack: closure captures by value (move)
    let name = String::from("world");
    let greeting = move || format!("Hello, {}!", name);

    // Stack: fn pointer (just an address)
    let op: fn(i32, i32) -> i32 = add;

    // Heap: boxed closure (trait object)
    let boxed_fn: Box<dyn Fn(i32) -> i32> = Box::new(|x| x * 2);

    let result = apply(op, 5, 10);
    let product = multiply(7);
}`,
  },
  {
    id: 'structs',
    title: 'Structs & Enums',
    description: 'Value types, Option, Result',
    code: `struct Point {
    x: f64,
    y: f64,
}

struct Player {
    name: String,
    score: u32,
    position: Point,
}

enum Shape {
    Circle(f64),
    Rectangle(f64, f64),
    Triangle { a: f64, b: f64, c: f64 },
}

enum Command {
    Quit,
    Echo(String),
    Move { x: i32, y: i32 },
}

fn main() {
    // Stack: all fields are primitives
    let origin = Point { x: 0.0, y: 0.0 };

    // Stack struct + heap String inside
    let player = Player {
        name: String::from("Alice"),
        score: 100,
        position: Point { x: 1.0, y: 2.0 },
    };

    // Stack: enum variant (sized by largest variant)
    let shape = Shape::Circle(5.0);

    // Stack: Option<i32> (niche optimization for small types)
    let maybe: Option<i32> = Some(42);

    // Stack metadata + heap for String inside
    let cmd = Command::Echo(String::from("hello"));

    // Result with heap-allocated error
    let result: Result<i32, String> = Ok(200);
}`,
  },
  {
    id: 'solana-anchor',
    title: 'Solana / Anchor Patterns',
    description: 'Common Anchor program patterns',
    code: `// NOTE: This shows standard Rust memory patterns
// used in Solana programs. Account data lives in
// Solana's runtime memory (not shown here).

const PROGRAM_ID: &str = "11111111111111111111111111111111";
const MAX_NAME_LEN: usize = 32;

static LAMPORTS_PER_SOL: u64 = 1000000000;

struct GameState {
    authority: [u8; 32],
    score: u64,
    name: [u8; 32],
    bump: u8,
}

fn process_instruction(
    program_id: &[u8; 32],
    accounts: &[u8],
    data: &[u8],
) -> u64 {
    // Stack: primitives
    let instruction = data[0];
    let amount: u64 = 100;

    // Stack: fixed-size array
    let seed: [u8; 32] = [0; 32];

    // Stack + heap: dynamic data
    let msg = String::from("Transfer successful");
    let account_keys: Vec<[u8; 32]> = Vec::new();

    // .rodata: string literal
    let log_prefix: &str = "Program log:";

    println!("{} {}", log_prefix, msg);

    0
}

fn main() {
    let pubkey: [u8; 32] = [0; 32];
    let result = process_instruction(&pubkey, &[], &[1]);
}`,
  },
  {
    id: 'advanced',
    title: 'Advanced Patterns',
    description: 'Pin, Cow, MaybeUninit, ZSTs',
    code: `use std::borrow::Cow;
use std::pin::Pin;

// Zero-sized type (0 bytes!)
struct Marker;

struct PinnedFuture {
    data: String,
}

fn process_name(input: &str) -> Cow<str> {
    if input.contains(' ') {
        // Owned: allocates on heap
        Cow::Owned(input.replace(' ', "_"))
    } else {
        // Borrowed: just a reference, no allocation
        Cow::Borrowed(input)
    }
}

fn main() {
    // Zero-sized type: takes 0 bytes on stack!
    let _marker = Marker;

    // Cow: borrowed (no heap alloc)
    let borrowed: Cow<str> = Cow::Borrowed("hello");

    // Cow: owned (heap alloc)
    let owned: Cow<str> = Cow::Owned(String::from("world"));

    // Pin<Box<T>>: pinned heap allocation
    let pinned = Box::pin(PinnedFuture {
        data: String::from("async data"),
    });

    // Tuple with mixed stack/heap types
    let mixed = (42i32, String::from("mixed"), true);

    // Array of heap types (stack array of stack metadata)
    let strings: [String; 3] = [
        String::from("a"),
        String::from("b"),
        String::from("c"),
    ];

    let result = process_name("hello world");
}`,
  },
];
