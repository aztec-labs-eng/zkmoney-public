#!/bin/bash

# Run necessary tests to check if the code is working as expected

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default options
EXCLUDE_CONTRACT_SERVICE=false
ENABLE_PROFILING=true  # Profiling enabled by default

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --exclude-contract-service)
            EXCLUDE_CONTRACT_SERVICE=true
            shift
            ;;
        --no-profile)
            ENABLE_PROFILING=false
            shift
            ;;
        --profile)
            ENABLE_PROFILING=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo "Options:"
            echo "  --exclude-contract-service    Skip contract service tests (also skips testnet PXE)"
            echo "  --profile                     Enable profiling for tests (default: enabled)"
            echo "  --no-profile                  Disable profiling for tests"
            echo "  -h, --help                    Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Print configuration status
if [ "$EXCLUDE_CONTRACT_SERVICE" = true ]; then
    print_warning "Contract service tests will be excluded"
fi
if [ "$ENABLE_PROFILING" = true ]; then
    print_status "Profiling is ENABLED (gate counts will be logged)"
else
    print_status "Profiling is DISABLED"
fi

# Function to cleanup background processes
cleanup() {
    print_status "Cleaning up background processes..."
    
    # Stop Aztec processes
    pkill -f "aztec start" || true
    pkill -f "aztec-nargo" || true
    
    # Kill the auto-shielder backend process
    pkill -f "bun.*auto-shielder" || true
    
    # Kill any other remaining background processes
    jobs -p | xargs -r kill || true
    
    print_success "Cleanup completed"
}

# Set up trap to cleanup on exit
trap cleanup EXIT

# Function to check if a port is available
check_port() {
    local port=$1
    if lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
        print_warning "Port $port is already in use. Attempting to kill existing process..."
        lsof -ti :"$port" | xargs kill -9 2>/dev/null || true
        sleep 2
    fi
}

# Function to wait for a service to be ready on a port
wait_for_port() {
    local port=$1
    local service_name=$2
    local max_attempts=${3:-60}  # Default 60 attempts (2 minutes)
    local attempt=1
    
    print_status "Waiting for $service_name to be ready on port $port..."
    
    # First wait for port to be listening
    while [ $attempt -le $max_attempts ]; do
        if lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            print_status "Port $port is listening, waiting for service to be fully ready..."
            sleep 5
            print_success "$service_name is ready on port $port"
            return 0
        fi
        sleep 2
        attempt=$((attempt + 1))
    done
    
    print_error "$service_name failed to start listening on port $port after $max_attempts attempts"
    return 1
}

# Function to wait for Aztec network to be fully ready (responds to RPC calls)
wait_for_aztec_ready() {
    local port=$1
    local max_attempts=${2:-90}  # Default 90 attempts (3 minutes)
    local attempt=1
    
    print_status "Waiting for Aztec network to be fully initialized on port $port..."
    
    # First wait for port to be listening
    while [ $attempt -le $max_attempts ]; do
        if lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            break
        fi
        sleep 2
        attempt=$((attempt + 1))
    done
    
    if [ $attempt -gt $max_attempts ]; then
        print_error "Aztec network failed to start listening on port $port"
        return 1
    fi
    
    print_status "Port $port is listening, waiting for Aztec to respond to RPC calls..."
    
    # Now wait for RPC to actually respond (indicates full initialization)
    attempt=1
    while [ $attempt -le $max_attempts ]; do
        # Try a simple RPC call to check if Aztec is ready
        if curl -s -X POST -H "Content-Type: application/json" \
            --data '{"jsonrpc":"2.0","method":"node_getVersion","params":[],"id":1}' \
            "http://localhost:$port" 2>/dev/null | grep -q "result"; then
            print_success "Aztec network is fully ready on port $port"
            # Give it a bit more time for all services to stabilize
            sleep 5
            return 0
        fi
        sleep 2
        attempt=$((attempt + 1))
    done
    
    print_error "Aztec network failed to respond to RPC calls after $max_attempts attempts"
    return 1
}

# Function to stop a process using a specific port
stop_service_on_port() {
    local port=$1
    local service_name=$2
    
    print_status "Stopping $service_name on port $port..."
    
    local pids
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
        print_success "$service_name stopped"
    fi
    
    # Wait for the port to be fully released
    local max_wait=15
    local wait_count=0
    while [ $wait_count -lt $max_wait ]; do
        if ! lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
            print_success "Port $port is now free"
            return 0
        fi
        sleep 1
        wait_count=$((wait_count + 1))
    done
    
    print_warning "Port $port may still be in use after waiting"
}

# Check if required tools are available
check_requirements() {
    print_status "Checking requirements..."
    
    if ! command -v aztec &> /dev/null; then
        print_error "aztec CLI is not installed. Please install it first:"
        print_error "bash -i <(curl -s https://install.aztec.network)"
        exit 1
    fi
    
    if ! command -v curl &> /dev/null; then
        print_error "curl is not installed. Please install it first."
        exit 1
    fi
    
    if ! command -v bun &> /dev/null; then
        print_error "bun is not installed. Please install it first."
        exit 1
    fi
    
    # Check and clear ports that might be in use
    check_port 8080
    check_port 8081
    check_port 3456  # Auto-shielder port
    
    print_success "All requirements met"
}

# Get Aztec version from environment or use default
AZTEC_VERSION=${AZTEC_VERSION:-"3.0.0-devnet.20251212"}
print_status "Using Aztec version: $AZTEC_VERSION"

# Check requirements
check_requirements

# ===== Shutdown existing services =====
print_status "Shutting down any existing services..."

# Kill auto-shielder processes
pkill -f "bun.*auto-shielder" 2>/dev/null || true

# Kill Aztec processes
pkill -f "aztec start" 2>/dev/null || true
pkill -f "aztec-nargo" 2>/dev/null || true

# Stop any docker containers using our ports
docker ps -q --filter "publish=8080" 2>/dev/null | xargs -r docker stop 2>/dev/null || true
docker stop $(docker ps -q --filter "ancestor=aztecprotocol/aztec" 2>/dev/null) 2>/dev/null || true

# Kill any remaining processes on the ports we need
for port in 3456 8080 8081; do
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        echo "$pids" | xargs kill -9 2>/dev/null || true
    fi
done

# Wait for ports to be released
sleep 3

print_success "Existing services shutdown complete"

# ===== PHASE 1: Start Local Network =====
print_status "=== PHASE 1: Starting Aztec Local Network ==="

# Start Aztec local network (includes node + PXE at port 8080)
print_status "Starting Aztec local network at port 8080..."
VERSION=$AZTEC_VERSION LOG_LEVEL=silent aztec start --local-network &
AZTEC_LOCAL_NETWORK_PID=$!
print_status "Aztec local network started with PID: $AZTEC_LOCAL_NETWORK_PID"

# Wait for local network to be fully ready (not just listening, but responding to RPC)
wait_for_aztec_ready 8080 120

# Check if local network is running
if ! kill -0 $AZTEC_LOCAL_NETWORK_PID 2>/dev/null; then
    print_error "Aztec local network failed to start"
    exit 1
fi

print_success "Aztec local network is ready!"

# Start auto-shielder backend (needed for auto-shield tests)
print_status "Starting auto-shielder backend..."
cd ../backend/auto-shielder
chmod +x run.sh
SILENT_MODE=true ./run.sh &
AUTO_SHIELDER_PID=$!
print_status "Auto-shielder backend started with PID: $AUTO_SHIELDER_PID"

# Navigate back to the sdk directory
cd ../../sdk

# Wait for auto-shielder to be ready
wait_for_port 3456 "Auto-Shielder Backend" 120

# Function to run a test and handle errors
run_test() {
    local test_name="$1"
    local test_file="$2"
    
    print_status "Running $test_name..."
    
    # Build environment variables for the test
    local env_vars="HIDE_CONSOLE_LOGS=true"
    
    # Add profiling if enabled
    if [ "$ENABLE_PROFILING" = true ]; then
        env_vars="$env_vars PROFILE=true"
    fi
    
    # Run test with configured environment
    if eval "$env_vars pnpm test:sandbox \"$test_file\""; then
        print_success "$test_name completed successfully"
    else
        print_error "$test_name failed"
        return 1
    fi
}

# ===== PHASE 2: Run Contract Service Test with Testnet (if not excluded) =====
if [ "$EXCLUDE_CONTRACT_SERVICE" = false ]; then
    print_status "=== PHASE 2: Running Contract Service Test with Testnet ==="
    
    # Run contract service test (connects to testnet via PXE)
    print_status "Running contract service tests..."
    run_test "Contract Service Tests" "contractService/contractServiceTestnet.test.ts"
else
    print_status "=== PHASE 2: Skipping Contract Service Tests (excluded) ==="
fi

# ===== PHASE 3: Run All Other Tests with Local Network =====
print_status "=== PHASE 3: Running All Other Tests with Local Network ==="

# Run email tests
print_status "Running OIDC key registry tests..."
run_test "OidcKeyRegistry Tests" "oidcKeyRegistry/oidcKeyRegistry.test.ts"

# Run account tests
print_status "Running account tests..."
run_test "Account Tests" "account/account.test.ts"

# Run authenticator tests
print_status "Running Webauthn Module tests..."
run_test "Webauthn Module Tests" "authenticators/webauthn.test.ts"

# Run token service tests
print_status "Running token service tests..."
run_test "Token Service Tests" "token/token.test.ts"

print_status "Running dripper tests..."
run_test "Dripper Tests" "token/dripper.test.ts"

# Run pay to email tests
print_status "Running pay to email tests..."
run_test "Pay to Email Tests" "payToEmail/payToEmail.test.ts"

print_status "Running two PXE pay to email tests..."
run_test "Two PXE Pay to Email Tests" "payToEmail/payToEmailTwoPXE.test.ts"

# Run auto-shield tests
print_status "Running auto-shield tests..."
run_test "Auto-Shield Tests" "auto-shield/auto-shield.test.ts"

print_status "Running auto-shield server tests..."
run_test "Auto-Shield Server Tests" "auto-shield/auto-shield-server.test.ts"

print_status "Running auto-shield two PXE tests..."
run_test "Auto-Shield Two PXE Tests" "auto-shield/auto-shield-two-pxe.test.ts"

# Run recovery tests
print_status "Running recovery tests..."
run_test "Recovery Tests" "recovery/recovery.test.ts"

print_status "Running MPK JWT method unit tests..."
run_test "MPK JWT Method Unit Tests" "recovery/mpk_jwt_method.unit.test.ts"

print_status "Running recovery payload unit tests..."
run_test "Recovery Payload Unit Tests" "recovery/recovery_payload.unit.test.ts"

print_success "All tests completed successfully!"
print_status "Cleaning up background processes..."
